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
