import os
import psycopg2
from fastapi import FastAPI, HTTPException

app = FastAPI()

# Ces deux constantes dépendent du schéma créé au chapitre 6 : à adapter au nom
# réel de la table de tâches et de sa colonne d'état avant de lancer le service.
TABLE_NAME = "tasks"
STATUS_COLUMN = "status"

# Les états attendus, listés ici pour garantir des compteurs à zéro même quand
# un état n'a aucune ligne en base (table vide, ou état jamais encore utilisé).
# Le modèle Node.js (chapitre 6) ne pose que 'pending' par défaut, sans workflow
# de transition d'état pour l'instant.
KNOWN_STATUSES = ["pending"]


def get_connection():
    # Ces noms de variables doivent être exactement ceux choisis au chapitre 7
    # pour l'API Node.js : les deux services lisent la même configuration, il
    # serait absurde qu'ils l'appellent différemment.
    return psycopg2.connect(
        host=os.environ["DB_HOST"],
        port=os.environ.get("DB_PORT", "5432"),
        dbname=os.environ["DB_NAME"],
        user=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
        connect_timeout=3,
    )


@app.get("/health")
def health():
    # Volontairement indépendant de Postgres : un souci base ne doit pas faire
    # passer le conteneur lui-même pour mort aux yeux du HEALTHCHECK.
    return {"status": "ok"}


@app.get("/stats")
def get_stats():
    counts = {status: 0 for status in KNOWN_STATUSES}
    try:
        conn = get_connection()
    except psycopg2.OperationalError:
        # Jamais de stacktrace brut renvoyé au client : un code d'erreur clair
        # et un message que l'appelant peut logger tel quel.
        raise HTTPException(
            status_code=503,
            detail="stats-api ne parvient pas à joindre la base de données",
        )
    try:
        with conn.cursor() as cursor:
            # TABLE_NAME et STATUS_COLUMN sont des constantes internes, jamais une
            # entrée utilisateur : l'interpolation ici ne rejoue pas le risque
            # d'injection SQL qu'on aurait avec un paramètre reçu du client.
            cursor.execute(
                f"SELECT {STATUS_COLUMN}, COUNT(*) FROM {TABLE_NAME} "
                f"GROUP BY {STATUS_COLUMN}"
            )
            for status, count in cursor.fetchall():
                counts[status] = count
    finally:
        conn.close()
    return counts
