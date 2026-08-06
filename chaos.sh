#!/bin/sh
# chaos.sh : tire une panne au hasard parmi cinq, sur todo-cluster.
# A lancer depuis votre poste, kubectl doit deja pointer sur todo-cluster.
N=$(( $(od -An -N1 -tu1 /dev/urandom) % 5 + 1 ))
echo "$N" | base64 > .incident # la reponse, pour le debriefing seulement

POD=$(kubectl get pods -n todo -l app=todo-api -o jsonpath='{.items[0].metadata.name}')
IMAGE=$(kubectl get deployment todo-api -n todo -o jsonpath='{.spec.template.spec.containers[0].image}')
REPO="${IMAGE%%:*}"

case "$N" in
  1) kubectl delete pod -n todo "$POD" ;; # un pod disparait
  2) kubectl exec -n todo "$POD" -- kill 1 ;; # le processus meurt a l'interieur du conteneur, sans que le pod disparaisse
  3) kubectl set image deployment/todo-api todo-api="${REPO}:ce-tag-n-existe-pas" -n todo ;; # l'image ciblee n'existe nulle part
  4) kubectl patch secret todo-secret -n todo --type=json \
       -p='[{"op":"remove","path":"/data/DB_PASSWORD"}]'
     kubectl rollout restart deployment/todo-api -n todo ;; # l'appli redemarre sans un secret qu'elle exige
  5) kubectl patch deployment todo-api -n todo --type=json \
       -p='[{"op":"replace","path":"/spec/template/spec/containers/0/resources","value":{"limits":{"memory":"8Mi"}}}]' ;; # la limite memoire ne laisse plus l'appli demarrer
esac >/dev/null 2>&1
