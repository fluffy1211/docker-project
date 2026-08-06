#!/bin/sh
# charge.sh : charge continue sur l'API, via l'Ingress, pendant N secondes.
# Usage : ./charge.sh <secondes>
DURATION="${1:-30}"
URL="http://localhost:8080/api/tasks"
END=$(( $(date +%s) + DURATION ))
TOTAL=0
FAILED=0
while [ "$(date +%s)" -lt "$END" ]; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: todo.localhost" "$URL")
  TOTAL=$((TOTAL + 1))
  if [ "$CODE" != "200" ]; then
    FAILED=$((FAILED + 1))
    echo "requete $TOTAL : code $CODE"
  fi
  sleep 0.1
done
echo "Total : $TOTAL requetes, $FAILED echouees (code != 200)"
