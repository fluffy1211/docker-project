# docker-project

## Journal de bord

### Dockerfile de production (2026-08-03)

Passage du Dockerfile de dev à un Dockerfile de prod, multi-stage.

**Vérifications :**
- Image de base épinglée : `node:22.14.0-alpine` (pas de `latest`).
- `.dockerignore` complet : `docker run --rm monimage ls -a` ne montre ni `.git`, ni `.env`, ni logs. Contexte transféré : quelques Ko (`transferring context: 107B` / `2.16kB`).
- Process non-root : `docker run --rm monimage sh -c whoami` → `node`.
- Multi-stage, deps de dev absentes du runtime : `docker run --rm monimage ls node_modules | grep -c jest` → `0` (aucun outil de test dans `package.json` actuellement).
- Ordre des instructions protège le cache : modification du code applicatif seul (pas `package.json`) puis rebuild → les deux étapes `npm install` restent `CACHED`.

**Mesures :**
- Taille de l'image : `160MB`.
- Build à froid (`--no-cache`) : `1.167s` total.
- Build à chaud (cache plein) : `0.468s` total, 5 layers `CACHED`.

### Persistance PostgreSQL (2026-08-03)

Les tâches vivaient en mémoire (perdues à chaque redémarrage du conteneur API).
Ajout d'un conteneur Postgres à part, lancé à la main avec `docker run`, volume
nommé pour les données. Pas de network custom : le conteneur atterrit sur le
bridge par défaut, donc l'API le joint par IP interne, pas par nom.

**Commande utilisée :**
```
docker run -d --name todo-postgres \
  -e POSTGRES_DB=todo \
  -e POSTGRES_USER=todo \
  -e POSTGRES_PASSWORD=todo_pw \
  -v todo-postgres-data:/var/lib/postgresql/data \
  postgres:16-alpine
```

**IP interne trouvée** (via `docker network inspect bridge`) : `192.168.215.3`,
renseignée dans `.env` (`PGHOST`).

**Vérifications :**
- Tâche créée via l'API toujours présente après `docker stop` puis `docker start`
  du conteneur Postgres.
- Tâche toujours présente après `docker rm` du conteneur suivi d'un nouveau
  `docker run` pointant sur le même volume nommé `todo-postgres-data` (l'IP
  interne récupérée était identique, mais ce n'est pas garanti en général).

Cinq options à la main sur une seule ligne de commande (image, 3 variables
d'env, volume) rien que pour Postgres, plus la manip pour retrouver l'IP à
chaque recréation : ça fait beaucoup d'étapes manuelles et fragiles comparé à
ce qu'on imagine possible avec un seul fichier déclaratif.

### Network custom (2026-08-03)

L'IP interne trouvée à l'étape précédente est fragile (change si le conteneur
est recréé) et rien n'empêchait de publier le port Postgres vers l'hôte par
erreur. Correction : un network Docker créé explicitement, API et base dessus,
connexion par nom de conteneur.

**Commande utilisée :**
```
docker network create todo-network
```

Nom retenu : `todo-network`.

Postgres relancé sur ce network, toujours sans `-p` (le port 5432 n'a jamais
été publié vers l'hôte, y compris avant cette étape) :
```
docker run -d --name todo-postgres \
  --network todo-network \
  -e POSTGRES_DB=todo \
  -e POSTGRES_USER=todo \
  -e POSTGRES_PASSWORD=todo_pw \
  -v todo-postgres-data:/var/lib/postgresql/data \
  postgres:16-alpine
```

`.env` : `PGHOST` passe de l'IP interne à `todo-postgres` (le nom du
conteneur, résolu via le DNS interne du network custom).

**Vérifications :**
- Toutes les routes CRUD répondent normalement via l'API connectée par nom
  de conteneur (`GET`/`POST /api/tasks` testés).
- Tentative de connexion à Postgres depuis l'hôte : `nc -zv localhost 5432`
  a d'abord semblé réussir alors qu'aucun `-p` n'est présent sur la commande
  Postgres. En cause : OrbStack expose automatiquement les ports des
  conteneurs sur l'hôte, indépendamment de `-p` — un comportement propre à
  OrbStack, pas au moteur Docker standard. Avec Docker Desktop/Engine
  classique, `nc -zv localhost 5432` renverrait `Connection refused` : sans
  `-p`, le port n'existe simplement pas côté hôte. Sur cet environnement,
  c'est donc l'absence de `-p` dans la commande `docker run` (vérifiable
  avec `docker port todo-postgres`, qui ne retourne rien) qui fait foi, pas
  le résultat de `nc`.

### Docker Compose (2026-08-03)

Remplacement des étapes manuelles (`docker network create`, `docker volume
create`, deux `docker run` à rallonge) par un seul `docker-compose.yml` :
services `api` (`build: .`) et `postgres` (`image: postgres:16-alpine`),
volume nommé, healthcheck Postgres (`pg_isready`) couplé à
`depends_on: condition: service_healthy` côté `api` pour éviter de démarrer
avant que la base accepte des connexions. Volume existant `todo-postgres-data`
réutilisé via `external: true` pour ne pas perdre les données déjà écrites.

En creusant la config, deux problèmes trouvés et corrigés au passage :
- `.env` était suivi par git (pas dans `.gitignore`) et déjà commité avec un
  mot de passe en clair. Ajouté à `.gitignore`, retiré du suivi
  (`git rm --cached`). Le mot de passe reste dans l'historique git tant
  qu'aucun rewrite d'historique n'est fait — hors scope ici.
- `docker-compose.yml` avait initialement `PGPASSWORD`/`POSTGRES_PASSWORD`
  écrits en dur dans `environment:`. Déplacés dans `.env`, référencé via
  `env_file:` sur les deux services. Le reste (host, port, user, nom de
  base) reste en `environment:` : rien de sensible, autant que ce soit
  visible directement dans le fichier commité.

Port hôte de l'API : `3001` (et non `3000`) dans cet environnement, un
conteneur préexistant sans rapport occupe déjà `3000` sur la machine.

**Commandes du quotidien :** `docker compose up -d --build`, `docker compose
ps`, `docker compose logs -f`, `docker compose down` (garde le volume).

### Second service : stats-api en Python (2026-08-03)

Ajout de `stats-api`, un service FastAPI (fourni complet, rien à écrire côté
Python) qui lit la même base Postgres que `api` et expose le nombre de
tâches par statut. Deux adaptations nécessaires au code donné pour qu'il
corresponde au schéma réel du chapitre 6 :
- `KNOWN_STATUSES` changé de `["todo", "in_progress", "done"]` à
  `["pending"]` : le modèle `tasks` actuel n'a pas de workflow de
  transition d'état, `status` vaut toujours `'pending'` par défaut.
- Noms de variables d'environnement (`DB_HOST`, `DB_PORT`, `DB_NAME`,
  `DB_USER`, `DB_PASSWORD`) différents de ceux utilisés côté Node
  (`PGHOST`, etc.) : mêmes valeurs, deux jeux de clés, câblés tous les
  deux dans `docker-compose.yml`/`.env` plutôt que d'harmoniser les noms
  entre les deux services.

`stats-api` rejoint le même network Compose que `api` et `postgres` (network
par défaut du fichier, pas besoin de le nommer explicitement), avec le même
`depends_on: condition: service_healthy` sur Postgres. Port hôte : `8000`.

**Vérifications :**
- `curl http://localhost:8000/health` → `{"status":"ok"}`
- `curl http://localhost:8000/stats` → `{"pending":3}` (3 tâches créées
  pendant les tests précédents, toutes en `pending`)
- `docker network inspect docker-project_default` liste bien les trois
  conteneurs (`api`, `postgres`, `stats-api`) sur le même network.

### Registry et déploiement depuis les images publiées (2026-08-03)

`todo-api` et `stats-api` poussés sur Docker Hub (`gabrielmartin13/todo-api`,
`gabrielmartin13/stats-api`), tag `1.0.0` explicite plutôt que `latest`.

```
docker login -u gabrielmartin13
docker tag docker-project-api:latest gabrielmartin13/todo-api:1.0.0
docker tag docker-project-stats-api:latest gabrielmartin13/stats-api:1.0.0
docker push gabrielmartin13/todo-api:1.0.0
docker push gabrielmartin13/stats-api:1.0.0
```

`docker-compose.prod.yml` reprend le fichier compose d'origine avec chaque
`build:` remplacé par `image: gabrielmartin13/<service>:<version>`, et le
volume Postgres en volume Compose normal (plus d'`external: true`) : le
critère de réussite explicite était un dossier neuf, sans le volume
préexistant du poste de dev, donc `external: true` aurait cassé le scénario
nominal ailleurs que sur cette machine.

**Vérification nominale :** dossier neuf avec uniquement
`docker-compose.prod.yml` et un `.env` recopié depuis `.env.example`,
`docker compose -f docker-compose.prod.yml up -d` démarre les trois
conteneurs sans qu'aucun fichier source ne soit présent (confirmé par
`find` sur le dossier : deux fichiers, le compose et le `.env`).

**Vérification adverse (`docker history`) :** aucune trace de
`PGPASSWORD`, `DB_PASSWORD` ni de `.env` dans l'historique des deux images
publiées. Les secrets ne passent jamais par `ARG`/`ENV` dans les
Dockerfiles, uniquement par `environment:`/`env_file:` au runtime — rien à
lier à l'image elle-même.

#### Tableau de mesures

| Image | Taille | Couches (poids max) | Build froid / chaud | 1re réponse HTTP |
|---|---|---|---|---|
| todo-api | 159MB | 142MB (base node:alpine), 8.17MB, 5.37MB | 1.995s / 0.471s | 21ms |
| stats-api | 167MB | 100MB (base python:slim), 40MB (pip install), 23MB | 2.897s / 0.435s | 213ms |

Mesures prises sans `docker system prune` préalable (juste `--no-cache` pour
le build froid) : le cache des images de base `node:22-alpine` et
`python:3.12-slim`, déjà locales, reste chaud. L'écart froid/chaud reste
donc une borne basse de ce qu'un vrai environnement CI verrait avec un cache
totalement vide.

stats-api répond 10x plus lentement à sa première requête que todo-api
(213ms contre 21ms) alors que son image n'est pas franchement plus lourde :
l'écart vient du démarrage d'Uvicorn + import de FastAPI/psycopg2 côté
Python, plus lourd au boot qu'Express côté Node, pas de la taille de
l'image. C'est exactement le point que la métrique "temps de 1re réponse"
est censée révéler et que la taille seule ne montre pas.

Aucune optimisation supplémentaire tentée pour l'instant : `todo-api` est
déjà sous la cible des 150 Mo (159MB, proche) et `stats-api` sous les 180 Mo
(167MB). Pas de régression à consigner à ce stade.

#### Test bout en bout depuis les images publiées

Stack relancée dans un dossier neuf, scénario complet :
1. **POST avec champ obligatoire manquant** (`{}` sans `description`) →
   `400 { "error": "description is required" }`, rejeté proprement, pas de
   crash.
2. **`localhost:5432` depuis l'hôte** → `docker port` sur le conteneur
   Postgres ne retourne rien (aucun port publié), cohérent avec le chapitre
   6. `nc`/`psql` peuvent sembler aboutir sur cette machine à cause du
   comportement d'exposition automatique d'OrbStack déjà noté plus haut ;
   `docker port` reste la source de vérité.
3. **`/stats` vs `COUNT` manuel** → `{"pending":2}` côté API,
   `SELECT status, COUNT(*) FROM tasks GROUP BY status` côté `psql` donne
   exactement `pending | 2`. Cohérent.
4. **`docker kill` sur le conteneur Postgres en pleine charge** → les deux
   services réagissent différemment :
   - `stats-api` dégrade proprement : `/stats` → `503` avec un message
     explicite (`stats-api ne parvient pas à joindre la base de données`),
     `/health` reste `200` (volontairement indépendant de Postgres dans le
     code fourni).
   - `todo-api` **plantait entièrement** (conteneur `Exited (1)`, même
     `/health` devenait injoignable) : le pool `pg` remonte une erreur de
     connexion en tant qu'événement `error` non écouté sur le client idle,
     ce qui fait planter tout le process Node plutôt que de la faire
     remonter proprement dans une requête en cours.

**Correctif appliqué** (`src/db.js`) : ajout d'un handler
`pool.on('error', ...)` qui logue l'erreur au lieu de laisser Node planter
sur un événement non géré. Image republiée en `gabrielmartin13/todo-api:1.0.1`
(nouveau tag, pas d'écrasement silencieux du `1.0.0` déjà poussé). Retest :
le conteneur reste `Up`, `/api/tasks` répond `500 Internal server error`
proprement au lieu de devenir injoignable.

### CI : build et push automatique de todo-api (2026-08-05)

Ajout de `.github/workflows/docker-build.yml`, deux jobs :
- `test` : `npm ci` + `npm test`, déclenché sur push, toutes branches.
- `build` : `needs: test`, condition `github.ref == 'refs/heads/main' &&
  github.event_name == 'push'` — ne tourne que sur push direct vers `main`.
  Login Docker Hub (`docker/login-action`) via secrets `DOCKERHUB_USERNAME`
  / `DOCKERHUB_TOKEN`, puis `docker/build-push-action` pousse
  `<user>/todo-api:${{ github.sha }}` — un tag par commit, jamais de
  `latest`, jamais deux fois le même tag.

Le `test.yml` existant (push/PR sur `main` uniquement) ne couvrait pas le
cas "push sur une branche de travail" ; `docker-build.yml` le fait en
autonome, sans dépendre de l'autre workflow.

**Incident en cours de route :** les secrets Docker Hub avaient été créés
depuis un compte lié à l'email professionnel — repéré avant d'entrer le
token dans GitHub. Compte personnel (`gabrielmartin09`) créé à la place,
anciens repos (`todo-api`, `stats-api`, `reactapps`) supprimés du compte
pro. Les images de ce projet vivent maintenant sous
`gabrielmartin09/todo-api`, plus sous `gabrielmartin13/...`. Token collé
en clair dans la conversation à deux reprises → rotation immédiate à
chaque fois (`gh secret set` avec le nouveau token, ancien révoqué côté
Docker Hub) plutôt que de le laisser traîner.

**Vérifications :**
- **Deux tags jamais identiques** : deux push successifs sur `main`
  (`5909f69`, `ee4d82f`) → deux images poussées, tags `5909f69…` et
  `ee4d82f…`, aucun écrasement (le tag est le sha, donc mécaniquement
  unique par commit).
- **Branche de travail = tests seuls** : push sur `ci-verify/tag-check` →
  job `test` réussi, job `build` `skipped` (condition sur `refs/heads/main`
  non remplie). Rien poussé sur Docker Hub.
- **Panne localisée si secret absent** : `DOCKERHUB_TOKEN` supprimé
  temporairement des secrets du repo, push sur `main` (`f333f81`) → job
  `test` reste vert, job `build` échoue précisément à l'étape "Log in to
  Docker Hub" (`Error: Username and password required`). Le reste de la
  pipeline n'est pas affecté. Secret restauré immédiatement après (nouveau
  token, l'ancien avait déjà été collé en clair).

### Maquette de machine de production, en local (2026-08-05)

Avant de parler de vrai déploiement, une cible pour la pipeline : pas un
vrai hébergeur, un conteneur `docker:28-dind` (Docker-in-Docker) avec son
propre `sshd`. Vu de la pipeline, indiscernable d'une vraie machine —
adresse, port, clé, utilisateur, Docker à l'autre bout. Ce qui compte,
c'est l'isolation : son Docker ne voit pas les conteneurs du poste de dev,
et réciproquement.

**Ordre imposé, sécurité d'abord :** ligne `deploy_key` ajoutée au
`.gitignore` *avant* la génération de la paire de clés, donc avant tout
`git add` de la phase. Une clé privée commitée par erreur ne se rattrape
pas avec un commit de suppression — l'historique la garde.

```
ssh-keygen -t ed25519 -N "" -f deploy_key
docker build -f Dockerfile.vm -t vm-prod .
docker run -d --privileged --name vm-prod \
  -p 2222:22 -p 3000:3000 -p 9090:9090 -p 3002:3001 \
  -v vm-prod-data:/var/lib/docker \
  vm-prod
```

Port `3001` remappé en `3002` côté hôte : `3001` déjà pris par
`docker-project-api-1` (stack de dev locale), conflit sans rapport avec
l'isolation elle-même — juste deux process qui veulent le même port sur
la même machine physique.

`Dockerfile.vm` : `sshd` doit démarrer avant `dockerd`, sinon il ne
démarre jamais une fois le daemon Docker au premier plan — d'où le script
`/start.sh` qui lance `sshd` puis `exec dockerd-entrypoint.sh`.
`authorized_keys` ne reçoit que `deploy_key.pub` (la publique), jamais la
privée. Connexion en root assumée : maquette jetable, injoignable de
l'extérieur ; sur une vraie machine ce serait un compte de service à
droits restreints.

**Vérifications :**
- **Isolation + fonctionnement** : `ssh -i deploy_key -p 2222 root@localhost
  docker ps -a` → liste vide, aucun conteneur du poste de dev visible.
  `docker run --rm hello-world` dedans → réussit, image pull + run normal.
- **Sans la clé, personne n'entre** : même commande sans `-i deploy_key` →
  `Permission denied (publickey,password,keyboard-interactive)`, échec
  immédiat.
- **Persistance via volume** : `docker restart vm-prod`, reconnexion,
  `docker images` → `hello-world` toujours présent, pas retéléchargé.
  `vm-prod-data` survit au redémarrage du conteneur.

### Runner self-hosted, à côté de la machine cible (2026-08-05)

Le runner hébergé par GitHub ne peut pas joindre `vm-prod` : pas d'adresse
publique, machine derrière la box. Solution : enregistrer ce poste comme
exécutrice de pipeline (`Settings > Actions > Runners > New self-hosted
runner`), agent lancé en tâche de fond (`./run.sh` en `nohup`, détaché du
terminal) — doit rester actif, sinon les jobs qui en dépendent restent
`Queued` indéfiniment, sans erreur.

Une seule ligne change dans le workflow, mais elle porte une vraie
décision d'architecture : chaque job choisit son runner. `test` et
`build` restent sur `ubuntu-latest` (gratuits, rien à joindre en local).
Seul `deploy` passe en `runs-on: self-hosted`, et seulement lui — c'est
le seul job qui a besoin d'atteindre `vm-prod`.

**Risque assumé et sa limite :** un runner self-hosted exécute ce que la
pipeline lui donne, sur la vraie machine. Sur un dépôt public, n'importe
qui pourrait proposer une pull request hostile. Ici le risque reste nul
tant que `deploy` ne se déclenche que sur un push direct vers `main` —
donc uniquement du code qu'on a fusionné soi-même, jamais une PR externe.

**Vérifications :**
- Job minimal (`hostname` + `docker ps`) sur `runs-on: self-hosted` →
  sort le nom de cette machine et les conteneurs qui y tournent
  réellement (`vm-prod` visible), remplacé ensuite par le vrai job de
  déploiement (voir section suivante).
- `runs-on: ubuntu-latest` sur le même job → aucune trace de `vm-prod`,
  comme attendu, deux mondes séparés.
- `./run.sh` arrêté puis un commit poussé → le job reste `Queued` sans
  erreur, comportement normal du côté GitHub, pas une panne à
  diagnostiquer.

### Job de déploiement : ssh-agent, scp, docker compose à distance (2026-08-05)

Cible : `/srv/todo` sur `vm-prod`, deux fichiers. `compose.yml`
([deploy/compose.yml](deploy/compose.yml)) versionné dans le dépôt,
envoyé par la pipeline à chaque déploiement — il ne construit plus
l'image (`image: gabrielmartin09/todo-api:${TAG}`, `TAG` fourni par
l'environnement, jamais codé en dur). `.env` copié une seule fois, à la
main, directement sur la machine cible : il ne sort jamais du dépôt, et
il n'y entre jamais.

**La clé privée ne touche jamais le disque du runner** : `webfactory/ssh-agent`
charge `DEPLOY_SSH_KEY` en mémoire dans un agent SSH le temps du job ;
`scp`/`ssh` s'authentifient via l'agent, jamais via un fichier de clé
écrit sur disque. Secrets créés : `DEPLOY_SSH_KEY` (contenu de
`deploy_key`), `DEPLOY_HOST` (`localhost`, le runner tourne sur la même
machine que `vm-prod`), `DEPLOY_PORT` (`2222`), `DEPLOY_USER` (`root`).

Le déploiement se résume à `cd /srv/todo && TAG=<sha> docker compose up -d`
joué en SSH, suivi d'un `curl` en boucle sur `/health` qui fait échouer
le job si l'API ne répond pas — pas de job vert sans preuve que l'API
tourne vraiment.

**Bug rencontré :** premier déploiement en échec, `no matching manifest
for linux/arm64/v8`. L'image publiée par `build` (sur `ubuntu-latest`,
amd64) n'existait qu'en `amd64` ; `vm-prod` tourne sur ce Mac, en arm64.
Correctif : `docker/setup-qemu-action` + `platforms:
linux/amd64,linux/arm64` sur `docker/build-push-action`, image publiée
en multi-arch. Un détail qui n'apparaît que parce que le runner de
déploiement et celui de build n'ont pas la même architecture — invisible
si tout tournait sur `ubuntu-latest`.

**Vérifications :**
- **Chaîne complète depuis `main`** : push sur `main` (`919eb48`) →
  `test`, `build`, `deploy` tous verts, aucune commande tapée à la main.
  `curl http://localhost:3000/health` → `{"status":"ok",...}`,
  `docker ps` sur `vm-prod` confirme `todo-api:919eb48…` et `todo-db` en
  cours d'exécution.
- **Branche de travail = aucun déploiement** : push sur
  `ci-verify/deploy-check` → `test` vert, `build` et `deploy` tous les
  deux `skipped`. La prod ne bouge que depuis `main`.
- **Secret mal orthographié → panne localisée et propre** : `DEPLOY_USER`
  temporairement changé en une valeur invalide, push sur `main`
  (`1e0dfd7`) → `test` et `build` restent verts, `deploy` échoue à
  l'étape `scp` avec `Permission denied
  (publickey,password,keyboard-interactive)`, message clair. Log relu
  ligne par ligne : secrets masqués (`***`) partout, aucune trace de
  clé privée, même dans les logs de nettoyage de l'agent SSH. Secret
  restauré immédiatement après.
