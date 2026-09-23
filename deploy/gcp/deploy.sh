#!/usr/bin/env bash
# Deploys the committed server code to the VM and (re)starts it. Safe to re-run.
# Ships only what's committed in git, so local data/ and keys never leave this Mac
# except the APNs key named in config.sh.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
if [ ! -f "$here/config.sh" ]; then
  echo "Copy config.example.sh to config.sh and fill it in first." >&2
  exit 1
fi
# shellcheck source-path=SCRIPTDIR source=config.example.sh
. "$here/config.sh"

if [ -z "$SPIKE_TOKEN" ]; then
  echo "Set SPIKE_TOKEN in config.sh (openssl rand -hex 24). The server is public." >&2
  exit 1
fi
if [ -n "$APNS_KEY_FILE" ] && [ ! -f "$APNS_KEY_FILE" ]; then
  echo "APNS_KEY_FILE not found: $APNS_KEY_FILE" >&2
  exit 1
fi
if ! git -C "$repo" diff --quiet HEAD -- server; then
  echo "Note: server/ has uncommitted changes; deploying the last commit ($(git -C "$repo" rev-parse --short HEAD))."
fi

gc() { gcloud --project="$PROJECT_ID" --quiet "$@"; }

umask 077
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT

git -C "$repo" archive --format=tar.gz -o "$stage/server.tgz" HEAD server
git -C "$repo" rev-parse --short HEAD >"$stage/REVISION"
cp "$here/provision.sh" "$stage/"
printf 'DOMAIN=%q\nACME_EMAIL=%q\n' "$DOMAIN" "$ACME_EMAIL" >"$stage/site.env"

{
  echo "PORT=8080"
  echo "HOST=127.0.0.1"
  echo "DATA_DIR=/var/lib/walkie"
  echo "SPIKE_TOKEN=$SPIKE_TOKEN"
  if [ -n "$APNS_KEY_FILE" ]; then
    echo "APNS_KEY_PATH=/etc/walkie/apns.p8"
    echo "APNS_KEY_ID=$APNS_KEY_ID"
    echo "APNS_TEAM_ID=$APNS_TEAM_ID"
    echo "APNS_BUNDLE_ID=$APNS_BUNDLE_ID"
  fi
} >"$stage/walkie.env"
if [ -n "$APNS_KEY_FILE" ]; then cp "$APNS_KEY_FILE" "$stage/apns.p8"; fi

echo "Uploading revision $(cat "$stage/REVISION") to $VM_NAME…"
gc compute ssh "$VM_NAME" --zone="$ZONE" --command="rm -rf /tmp/walkie-deploy && mkdir -m 700 /tmp/walkie-deploy"
gc compute scp --zone="$ZONE" "$stage"/* "$VM_NAME:/tmp/walkie-deploy/"
gc compute ssh "$VM_NAME" --zone="$ZONE" --command="sudo bash /tmp/walkie-deploy/provision.sh /tmp/walkie-deploy"

echo "Checking https://$DOMAIN/healthz (the first deploy waits for the certificate)…"
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 "https://$DOMAIN/healthz" >/dev/null 2>&1; then
    echo "Deployed. Server is up at https://$DOMAIN"
    exit 0
  fi
  sleep 3
done
echo "The server didn't answer over HTTPS yet. Check DNS (dig +short $DOMAIN) and the logs:" >&2
echo "  gcloud compute ssh $VM_NAME --zone=$ZONE --project=$PROJECT_ID -- sudo journalctl -u walkie -u caddy -n 50" >&2
exit 1
