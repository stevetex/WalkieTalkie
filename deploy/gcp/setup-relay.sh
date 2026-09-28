#!/usr/bin/env bash
# One-time setup for option E's relay nodes, after setup-firestore.sh: the image
# repository, the relay's secrets, and the health check the instance group heals with.
# Safe to re-run; existing resources are left alone (secrets aren't overwritten).
#
# The nodes reuse the walkie-web firewall rule (ports 80 and 443 from anywhere), which
# also admits Google's health checkers on port 80.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR source=config.example.sh
. "$here/config.sh"

node_sa="relay-node@$PROJECT_ID.iam.gserviceaccount.com"
gc() { gcloud --project="$PROJECT_ID" --quiet "$@"; }

echo "Enabling Artifact Registry, Cloud Build, Secret Manager and Public CA…"
gc services enable artifactregistry.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com \
  publicca.googleapis.com

if ! gc artifacts repositories describe relay --location="$REGION" >/dev/null 2>&1; then
  echo "Creating the relay image repository in ${REGION}…"
  gc artifacts repositories create relay --location="$REGION" --repository-format=docker \
    --description="Over&Out relay node images"
fi
gc artifacts repositories add-iam-policy-binding relay --location="$REGION" \
  --member="serviceAccount:$node_sa" --role=roles/artifactregistry.reader >/dev/null

# create_secret <id> <file or - for stdin>. The value is never printed.
create_secret() {
  if gc secrets describe "$1" >/dev/null 2>&1; then
    cat >/dev/null
    return
  fi
  echo "Creating secret $1…"
  gc secrets create "$1" --replication-policy=user-managed --locations="$REGION" --data-file=- >/dev/null
}
if [ -z "$SPIKE_TOKEN" ]; then echo "Set SPIKE_TOKEN in config.sh first." >&2; exit 1; fi
printf %s "$SPIKE_TOKEN" | create_secret relay-token
if [ -n "$APNS_KEY_FILE" ]; then create_secret apns-key <"$APNS_KEY_FILE"; fi
# Google Trust Services (Public CA) external account key: Caddy uses it once, to register
# the node's ACME account, which it then keeps on the node's disk. A key registers one
# account, so before adding another node, add a fresh version:
#   gcloud publicca external-account-keys create --format=json | gcloud secrets versions add acme-eab --data-file=-
if ! gc secrets describe acme-eab >/dev/null 2>&1; then
  # Held in a variable first, so a failed request doesn't create an empty secret.
  eab=$(gc publicca external-account-keys create --format=json)
  printf %s "$eab" | create_secret acme-eab
  unset eab
fi
for secret in relay-token apns-key acme-eab; do
  if gc secrets describe "$secret" >/dev/null 2>&1; then
    gc secrets add-iam-policy-binding "$secret" --member="serviceAccount:$node_sa" \
      --role=roles/secretmanager.secretAccessor >/dev/null
  fi
done

if ! gc compute health-checks describe relay-health >/dev/null 2>&1; then
  echo "Creating the relay-health check (HTTP :80/healthz, through Caddy to the relay)…"
  # Unhealthy after 3 failures 10 s apart; the group then recreates the node.
  gc compute health-checks create http relay-health --port=80 --request-path=/healthz \
    --check-interval=10s --timeout=5s --healthy-threshold=2 --unhealthy-threshold=3
fi

echo "Relay setup done. Next: deploy/gcp/build-image.sh, then deploy/gcp/deploy-relay.sh."
