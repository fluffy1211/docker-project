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
