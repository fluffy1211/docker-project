# Procédure de déploiement — Todo API

Ce document explique comment déployer la Todo API sur la machine cible,
comment vérifier que ça a marché, et comment revenir en arrière si ce
n'est pas le cas. Le déploiement est automatique (push sur `main`
déclenche la pipeline GitHub Actions) ; cette procédure décrit ce que
la pipeline fait, pour pouvoir la rejouer à la main si elle est en
panne, l'auditer, ou diagnostiquer un incident.

Durée normale d'un déploiement complet (`test` + `db-tests` + `build` +
`deploy`) : **environ 2 minutes**. Au-delà de 5 minutes sans que
`deploy` ait démarré ou terminé, quelque chose ne va pas — voir
_Pannes connues_ plus bas.

## Prérequis

Avant de commencer, avoir sous la main :

- **Accès SSH à la machine cible** : la clé privée `deploy_key` (jamais
  commitée, cherchez-la auprès de qui a fait le déploiement précédent
  ou générez-en une nouvelle et mettez à jour le secret GitHub
  `DEPLOY_SSH_KEY` et `authorized_keys` sur la cible).
- **Adresse et port de la machine cible** : voir les secrets GitHub
  `DEPLOY_HOST` et `DEPLOY_PORT` (Settings > Secrets and variables >
  Actions du dépôt). Sur la maquette locale de ce projet :
  `DEPLOY_HOST=localhost`, `DEPLOY_PORT=2222`, `DEPLOY_USER=root`.
- **Emplacement des fichiers sur la cible** : tout vit dans `/srv/todo`
  — `compose.yml`, `prometheus.yml`, `grafana/` (poussés par la
  pipeline à chaque déploiement) et `.env` (copié une seule fois à la
  main, ne part jamais du dépôt, n'y entre jamais).
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
4. Le job `deploy` envoie `compose.yml` + `prometheus.yml` + `grafana/`
   sur la cible, puis lance `docker compose up -d` avec le nouveau
   tag, puis vérifie `/health`.
   - **Vérification** : le job `deploy` est vert dans l'onglet Actions
     _et_ `curl -s http://<DEPLOY_HOST>:3000/health` répond
     `{"status":"ok",...}` _et_ le panneau **Disponibilité** du
     dashboard Grafana affiche `1`.

Si l'une de ces vérifications échoue, ne pas repousser un nouveau
commit en espérant que ça passe : lire le log du job en échec
(_Pannes connues_ plus bas couvre les cas les plus fréquents), et si
la prod est cassée, passer directement au retour arrière ci-dessous.

## Déploiement manuel (si la pipeline est indisponible)

À jouer depuis un poste avec `deploy_key` et un accès réseau à la
cible.

1. Se connecter à Docker Hub, puis construire et pousser l'image :
   ```
   docker login -u gabrielmartin09
   docker buildx build --platform linux/arm64 \
     -t gabrielmartin09/todo-api:<sha> --push .
   ```
   **Vérification** : `docker pull gabrielmartin09/todo-api:<sha>`
   réussit depuis n'importe quel poste.

2. Envoyer la configuration sur la cible :
   ```
   scp -r -i deploy_key -P <DEPLOY_PORT> deploy/. \
     <DEPLOY_USER>@<DEPLOY_HOST>:/srv/todo/
   ```
   **Vérification** :
   `ssh -i deploy_key -p <DEPLOY_PORT> <DEPLOY_USER>@<DEPLOY_HOST> "ls /srv/todo"`
   liste `compose.yml`, `prometheus.yml`, `grafana`, et `.env`
   (`.env` doit déjà être là — cette commande ne le touche pas).

3. Déployer :
   ```
   ssh -i deploy_key -p <DEPLOY_PORT> <DEPLOY_USER>@<DEPLOY_HOST> \
     "cd /srv/todo && TAG=<sha> docker compose up -d"
   ```
   **Vérification** : la commande se termine sans `Error response
   from daemon`. `docker ps` sur la cible montre `todo-api`,
   `todo-db`, `prometheus`, `grafana` tous `Up`.

4. Confirmer que l'API répond :
   ```
   curl -s http://<DEPLOY_HOST>:3000/health
   ```
   **Vérification** : `{"status":"ok","timestamp":"..."}`. Si rien ne
   répond après 30 secondes, passer au retour arrière.

## Retour arrière

**Qui décide** : quiconque constate que `/health` ne répond plus, que
le panneau Disponibilité est à `0`, ou que le taux d'erreur grimpe de
façon soutenue après un déploiement. Pas besoin d'attendre une
validation — un rollback est réversible, le laisser en prod cassé ne
l'est pas.

**Critère de déclenchement** : `/health` ne répond pas dans les 30
secondes suivant un déploiement, ou le panneau Erreurs dépasse un taux
anormal (au-delà de ce qu'on voit habituellement en dehors d'une
boucle de charge volontaire) de façon soutenue sur plus d'une minute.

**Commande** (la version précédente est déjà sur Docker Hub, pas
besoin de rebuild) :
```
cd /srv/todo && TAG=<sha précédent connu bon> docker compose up -d
```

**Attention** : cette commande seule ne suffit **que si le
`compose.yml` n'a pas changé** entre les deux versions. Si la
régression touche `compose.yml` lui-même (variable d'environnement,
nom de service, port), remettre aussi l'ancien `compose.yml` avant de
rejouer la commande — depuis un clone local du dépôt :
```
git show <sha précédent connu bon>:deploy/compose.yml > /tmp/compose-rollback.yml
scp -i deploy_key -P <DEPLOY_PORT> /tmp/compose-rollback.yml \
  <DEPLOY_USER>@<DEPLOY_HOST>:/srv/todo/compose.yml
```
puis rejouer la commande de retour arrière ci-dessus.

**Vérification du retour arrière** : `curl -s
http://<DEPLOY_HOST>:3000/health` répond `ok`, et le panneau
Disponibilité repasse à `1`.

Pour retrouver le sha précédent connu bon : `git log --oneline main`
dans le dépôt, ou l'historique des tags sur Docker Hub
(`gabrielmartin09/todo-api`), ou le dashboard Grafana (dernier moment
où le panneau Disponibilité était stable à `1`).

## Pannes connues et leur signature

| Panne | Où ça casse | Signature dans le dashboard / les logs | Diagnostic | Correctif |
|---|---|---|---|---|
| Secret Docker Hub manquant ou retiré | job `build`, étape "Log in to Docker Hub" | Aucun changement dans le dashboard (rien n'est déployé, l'ancienne version tourne encore) | Log du job `build` : `Error: Username and password required` | Restaurer `DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN` dans les secrets du dépôt |
| Secret de déploiement mal orthographié (`DEPLOY_USER`, `DEPLOY_HOST`, `DEPLOY_PORT`) | job `deploy`, étape scp ou ssh | Aucun changement dans le dashboard (le déploiement n'a jamais atteint la cible) | Log du job `deploy` : `Permission denied` ou `Connection refused`/`timed out` | Corriger le secret concerné dans Settings > Secrets |
| `PGHOST` (ou toute variable de connexion) faux dans `compose.yml` | conteneur `todo-api` sur la cible, au démarrage | Panneau Disponibilité tombe à `0` (ou reste instable, redémarrages en boucle) ; `docker logs todo-api` montre `ENOTFOUND` ou `ECONNREFUSED` | `docker ps -a` sur la cible : `todo-api` en `Restarting` | Corriger `deploy/compose.yml` dans le dépôt, redéployer. Si déjà en prod : retour arrière avec restauration du `compose.yml` (voir plus haut) |
| Port `3000` déjà occupé sur la cible par un autre conteneur | `docker compose up -d` sur la cible, au moment de démarrer `todo-api` | Panneau Disponibilité tombe à `0` et **reste** à `0` (contrairement aux autres pannes de cette liste, celle-ci touche la prod même en déploiement manuel) ; `docker ps -a` montre `todo-api` en `Exited` | Message exact : `Bind for 0.0.0.0:3000 failed: port is already allocated` | Identifier le conteneur fautif (`docker ps` sur la cible, chercher qui publie `3000`), l'arrêter ou le reconfigurer, puis rejouer `docker compose up -d` |
| Build QEMU plante sur `npm ci` (émulation arm64 sur un runner amd64) | job `build`, étape "Build and push" | Aucun changement dans le dashboard (rien n'est construit ni déployé) | Log du job `build` : `qemu: uncaught target signal 4 (Illegal instruction)` | Ne pas émuler : builder nativement sur un runner de la même architecture que la cible (déjà fait, `build` tourne en `self-hosted` arm64, plus de QEMU dans ce pipeline) |
| Retour arrière vers un tag qui n'existe pas sur Docker Hub | `docker compose up -d` (rollback manuel) | Aucun changement dans le dashboard : le conteneur existant n'est jamais arrêté avant que le pull échoue | Message exact : `manifest for gabrielmartin09/todo-api:<tag> not found: manifest unknown` | Vérifier le sha exact (`git log`, ou tags Docker Hub) et rejouer avec le bon |

## Vérifications post-déploiement, en une ligne

```
curl -s http://<DEPLOY_HOST>:3000/health && echo OK
```

Et dans Grafana (`http://<adresse de la cible>:3001`, ou le port
remappé si la cible est elle-même conteneurisée derrière un `docker
run -p`) : panneau **Disponibilité** à `1`, panneau **Trafic** non nul
si du trafic est attendu, panneau **Erreurs** proche de son niveau
habituel, panneau **Latence (p95)** stable.
