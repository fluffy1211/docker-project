# Procédure de déploiement — Todo API

Ce document explique comment déployer la Todo API sur `todo-cluster`
(Kubernetes, via k3d), comment vérifier que ça a marché, et comment
revenir en arrière si ce n'est pas le cas. Le déploiement est
automatique (push sur `main` déclenche la pipeline GitHub Actions) ;
cette procédure décrit ce que la pipeline fait, pour pouvoir la
rejouer à la main si elle est en panne, l'auditer, ou diagnostiquer un
incident.

Il n'y a plus de SSH dans cette procédure : la cible est le cluster
qui tourne sur la même machine que le runner self-hosted, joint par
`kubectl`, jamais par un accès distant à une VM.

Durée normale d'un déploiement complet (`test` + `db-tests` + `build`
+ `deploy`) : **environ 2 minutes**, `deploy` lui-même convergeant en
quelques secondes une fois l'image poussée. Au-delà de 5 minutes sans
que `deploy` ait démarré ou terminé, quelque chose ne va pas — voir
_Pannes connues_ plus bas.

## Accès attendu pour intervenir

- **`kubectl` configuré sur `todo-cluster`** : `k3d cluster create`
  fusionne automatiquement les identifiants dans `~/.kube/config` à la
  création du cluster. Vérifier avant toute commande :
  ```
  kubectl config current-context
  ```
  **Vérification** : doit répondre `k3d-todo-cluster`. Si ce n'est pas
  le cas, `kubectl config use-context k3d-todo-cluster` avant de
  continuer — toute commande lancée sur le mauvais contexte agit sur
  un autre cluster sans avertissement.
- **Namespace `todo`** : tous les objets applicatifs y vivent. Créé par
  `kubectl apply -f k8s/namespace.yaml` (à faire une seule fois par
  cluster, avant le tout premier déploiement — absent, tout le reste
  échoue avec `namespaces "todo" not found`). Ajouter `-n todo` à
  chaque commande `kubectl` de cette procédure (ou `kubectl
  config set-context --current --namespace=todo` une fois pour toute
  la session).
- **Accès en écriture au dépôt** `fluffy1211/docker-project`, branche
  `main`, pour déclencher un déploiement en poussant du code.
- **Identifiants Docker Hub** : l'image se trouve sur
  `gabrielmartin09/todo-api`, taguée au sha du commit.

## Déploiement (automatique)

1. Pousser sur `main` (directement, ou merger une PR).
   - **Vérification** : l'onglet **Actions** du dépôt montre un
     nouveau run du workflow `Build and Push Todo API` qui démarre.
2. Attendre que les jobs `test` et `db-tests` passent (parallèles).
   - **Vérification** : les deux jobs affichent une coche verte dans
     l'onglet Actions, en moins d'une minute chacun.
3. Le job `build` construit l'image et la pousse sur Docker Hub, taguée
   au sha du commit.
   - **Vérification** : `gabrielmartin09/todo-api:<sha du commit>`
     apparaît dans la liste des tags sur Docker Hub.
4. Le job `deploy` exécute `kubectl set image deployment/todo-api
   todo-api=gabrielmartin09/todo-api:<sha> -n todo`, puis `kubectl
   rollout status deployment/todo-api -n todo --timeout=120s`.
   - **Vérification** : le job `deploy` est vert dans l'onglet Actions
     _et_ `kubectl describe deployment todo-api -n todo` montre le
     nouveau sha dans l'image des pods _et_ `curl -s -H "Host:
     todo.localhost" http://localhost:8080/health` répond
     `{"status":"ok",...}`.

Si l'une de ces vérifications échoue, ne pas repousser un nouveau
commit en espérant que ça passe : lire le log du job en échec
(_Pannes connues_ plus bas couvre les cas les plus fréquents), et si
la prod est cassée, passer directement au retour arrière ci-dessous.
Le job `deploy` lui-même refuse de se déclarer vert si le rollout ne
converge pas dans le délai fixé — un rollout bloqué (image
inexistante, sonde qui ne passe jamais) fait échouer la pipeline,
jamais un faux succès.

## Déploiement manuel (si la pipeline est indisponible)

À jouer depuis un poste avec `kubectl` configuré sur `todo-cluster`
(voir _Accès attendu_ ci-dessus) et accès à Docker Hub.

1. Construire et pousser l'image (si elle n'existe pas déjà pour ce
   sha) :
   ```
   docker login -u gabrielmartin09
   docker buildx build --platform linux/arm64 \
     -t gabrielmartin09/todo-api:<sha> --push .
   ```
   **Vérification** : `docker pull gabrielmartin09/todo-api:<sha>`
   réussit depuis n'importe quel poste.

2. Mettre à jour le `Deployment` :
   ```
   kubectl set image deployment/todo-api todo-api=gabrielmartin09/todo-api:<sha> -n todo
   ```
   **Vérification** : `kubectl get pods -n todo -l app=todo-api`
   montre de nouveaux pods apparaître (nouveau suffixe de nom).

3. Attendre la convergence :
   ```
   kubectl rollout status deployment/todo-api -n todo --timeout=120s
   ```
   **Vérification** : la commande affiche `deployment "todo-api"
   successfully rolled out` et rend la main. Si elle échoue ou
   n'aboutit jamais (`ImagePullBackOff`, sonde qui ne passe jamais),
   voir _Pannes connues_ plus bas — ne pas attendre indéfiniment.

4. Confirmer que l'API répond :
   ```
   curl -s -H "Host: todo.localhost" http://localhost:8080/health
   ```
   **Vérification** : `{"status":"ok","timestamp":"..."}`. Si rien ne
   répond, vérifier `kubectl get ingress -n todo` et `kubectl get pods
   -n todo` avant de conclure à une régression applicative.

## Retour arrière

**Qui décide** : quiconque constate que `/health` ne répond plus, que
`GET /api/tasks` renvoie des erreurs de façon soutenue, ou que
`kubectl rollout status` ne converge pas après un déploiement. Pas
besoin d'attendre une validation — un rollback est réversible, le
laisser en prod cassé ne l'est pas.

**Critère de déclenchement** : `/health` ou une route applicative
(`GET /api/tasks`) ne répond pas correctement dans les 30 secondes
suivant un déploiement, ou le taux d'erreur grimpe de façon soutenue
sur plus d'une minute (au-delà de ce qu'on voit habituellement en
dehors d'une boucle de charge volontaire).

**Attention, limite connue des sondes** (voir tableau de pannes
ci-dessous, et la phase probes du Journal de bord) : `/health`
confirme seulement que le serveur HTTP écoute, jamais que la base de
données répond. Un déploiement peut avoir des pods `Running`/`1/1` et
un `rollout status` vert tout en étant cassé pour de vrai — toujours
tester une route qui touche la base (`GET /api/tasks`) avant de
déclarer un déploiement sain, pas seulement `/health`.

**Commande** :
```
kubectl rollout undo deployment/todo-api -n todo
kubectl rollout status deployment/todo-api -n todo --timeout=120s
```

Revient à la révision précédente — image **et** spec du pod (probes,
ressources, env) en une seule commande, contrairement à l'ancien
monde SSH où le tag et le `compose.yml` étaient deux choses séparées
à restaurer.

Pour cibler une révision précise plutôt que la précédente :
```
kubectl rollout history deployment/todo-api -n todo
kubectl rollout undo deployment/todo-api -n todo --to-revision=<N>
```

**Vérification du retour arrière** : `curl -s -H "Host:
todo.localhost" http://localhost:8080/health` répond `ok`, **et**
`curl -s -o /dev/null -w '%{http_code}' -H "Host: todo.localhost"
http://localhost:8080/api/tasks` répond `200` (pas seulement
`/health`, voir la limite ci-dessus).

**Si rien n'a encore été déployé** (`Deployment` sans historique de
rollout), `kubectl rollout undo` échoue proprement :
```
error: no rollout history found for deployment "todo-api"
```
Rien n'est laissé à moitié en place — ce n'est pas un cas à corriger,
juste un signal qu'il n'y a rien à annuler.

## Pannes connues et leur signature

| Panne | Signature dans `kubectl get pods` | Signature dans `describe`/events | Se répare seule ? | Remède |
|---|---|---|---|---|
| Pod supprimé | pod disparaît puis un nouveau apparaît (nouveau nom) en quelques secondes | `Scheduled` → `Pulled`/`Created`/`Started` sur le nouveau pod | **Oui** | Aucun — la boucle de réconciliation recrée le pod manquant |
| Processus tué dans le conteneur | attendu : `RESTARTS` s'incrémente, conteneur relancé en place | attendu : événement de redémarrage sur le même pod | **Oui** (en théorie — voir note ci-dessous) | Aucun en principe ; si le symptôme persiste sans `RESTARTS` qui bouge, traiter comme une anomalie d'environnement, pas comme une vraie panne applicative |
| Tag d'image inexistant | nouveau pod bloqué `0/1 ImagePullBackOff`, anciens pods restent `Running` | `Failed to pull image` puis `Back-off pulling image` | **Non** | `kubectl set image` vers un tag existant, ou `kubectl rollout undo` |
| Clé du Secret supprimée (`DB_USER`/`DB_PASSWORD`) | pods `1/1 Running`, rien d'anormal visible | aucun événement — les sondes ne testent que `/health`, jamais la base | **Non**, silencieux (`/health` reste `ok`, seul `GET /api/tasks` → `500` le révèle) | Restaurer la clé (`kubectl apply -f k8s/todo-secret.yaml`), puis `kubectl rollout restart deployment/todo-api -n todo` |
| Limite mémoire trop basse | `0/1 CrashLoopBackOff`, `RESTARTS` grimpe | `Last State: Terminated`, `Reason: OOMKilled`, `Exit Code: 137` | **Non** | Remonter `resources.limits.memory` dans `k8s/todo-api-deployment.yaml`, `kubectl apply -f` |
| `kubectl` pointé sur le mauvais cluster (contexte non précisé) | toute commande semble réussir ou échouer, mais sur un cluster/namespace qui n'est pas `todo-cluster`/`todo` — aucune trace de l'effet attendu sur le vrai cluster | `kubectl get pods -n todo` peut renvoyer `No resources found` ou des pods sans rapport | **Non** — ce n'est pas une panne du cluster, c'est un opérateur qui agit au mauvais endroit | Toujours vérifier `kubectl config current-context` avant une commande d'urgence (voir _Accès attendu_ en haut de ce document) ; corriger avec `kubectl config use-context k3d-todo-cluster` |
| `ConfigMap` modifié mais pod jamais redémarré | pod reste `1/1 Running`, aucune erreur | rien dans les événements — ce n'est pas un crash | **Non**, silencieux (l'ancienne valeur reste active dans l'environnement déjà chargé du conteneur) | `kubectl rollout restart deployment/todo-api -n todo` pour forcer les pods à relire le `ConfigMap` |

**Note sur "processus tué dans le conteneur" :** ce cas est documenté
d'après le comportement attendu de Kubernetes (le kubelet redémarre un
conteneur dont le process principal meurt). Sur cette maquette (k3d
imbriqué dans un moteur de conteneurs de bureau), l'envoi du signal via
`kubectl exec ... -- kill` n'a pas produit d'effet observable lors du
diagnostic de la phase 20 du Journal de bord — anomalie d'environnement
documentée là, pas un comportement à corriger dans les manifestes.

## Limite connue : `/health` ne garantit pas que la base répond

`/health` répond `{"status":"ok",...}` dès que le serveur HTTP Express
écoute — il n'exécute aucune requête vers Postgres. Conséquence directe
: `readinessProbe` et `livenessProbe`, toutes deux basées sur
`/health`, peuvent laisser un pod `1/1 Ready` alors que la base est
injoignable (`todo-db` scalé à `0`, mot de passe supprimé du Secret,
etc.) — `GET /api/tasks` répond `500` pendant que tout, côté cluster,
a l'air normal.

Ce choix est documenté, pas corrigé : un `/health` qui interroge la
base à chaque appel protégerait de ce mensonge, mais exposerait
l'application à une cascade de sondes qui échouent toutes en même
temps si la base ralentit seulement un peu (les trois replicas
perdraient leur readiness simultanément). En pratique : ne jamais
se fier à `/health` seul pour valider un déploiement ou un retour
arrière — toujours tester une route qui touche réellement la base.

## Vérifications post-déploiement, en une ligne

```
curl -s -H "Host: todo.localhost" http://localhost:8080/health && \
curl -s -o /dev/null -w ' [%{http_code}]\n' -H "Host: todo.localhost" http://localhost:8080/api/tasks
```

Et côté cluster :
```
kubectl get pods -n todo -l app=todo-api
kubectl rollout status deployment/todo-api -n todo
```
`READY` à `3/3` sur tous les pods `todo-api`, `rollout status`
répondant immédiatement `successfully rolled out` (pas de rollout en
cours).
