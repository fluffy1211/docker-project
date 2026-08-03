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
