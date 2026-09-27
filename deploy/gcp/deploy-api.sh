#!/usr/bin/env bash
# Deploys the account API (server/src/api-main.ts) to Cloud Run as the service "api", from
# the committed code. It scales to zero; overandout.app/v1/* reaches it through Firebase
# Hosting (deploy-web.sh). Run setup-api.sh once first.
#
#   deploy/gcp/deploy-api.sh [commit]     (default: HEAD)
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR source=config.example.sh
. "$here/config.sh"

gc() { gcloud --project="$PROJECT_ID" --quiet "$@"; }

image=$(IMAGE=api "$here/build-image.sh" "$@")
rev=${image##*:}

umask 077
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
# The service's settings. No secrets: the API reads those from Secret Manager at startup.
{
  echo "STORE: firestore"
  echo "SESSION_SIGNING_KEY_SECRET: session-signing-key"
  echo "SESSION_PUBLIC_KEYS_SECRET: session-public-keys"
  echo "APPLE_AUDIENCES: \"${APPLE_AUDIENCES:-com.cypressoakstudios.overandout}\""
  echo "INVITE_BASE_URL: https://overandout.app/i/"
  if gc secrets describe apple-siwa-key >/dev/null 2>&1; then
    echo "APPLE_SIWA_KEY_SECRET: apple-siwa-key"
    echo "APPLE_SIWA_KEY_ID: \"$APPLE_SIWA_KEY_ID\""
    echo "APPLE_TEAM_ID: \"${APPLE_TEAM_ID:-$APNS_TEAM_ID}\""
  fi
} >"$stage/env.yaml"

echo "Deploying $image to Cloud Run (api, $REGION)…"
# Scale to zero; a cold start (~1–2 s) only delays sign-in, invites and friend lists, never
# a ring. Anyone can call it: every route checks its own token.
gc run deploy api --image="$image" --region="$REGION" \
  --service-account="api@$PROJECT_ID.iam.gserviceaccount.com" \
  --allow-unauthenticated --ingress=all \
  --min-instances=0 --max-instances=4 --cpu=1 --memory=512Mi --concurrency=80 --timeout=30s \
  --env-vars-file="$stage/env.yaml"

url=$(gc run services describe api --region="$REGION" --format='value(status.url)')
if curl -fsS --max-time 20 "$url/v1/health" | grep -q "\"revision\":\"$rev\""; then
  echo "$url serves $rev"
else
  echo "$url isn't serving $rev" >&2
  exit 1
fi
