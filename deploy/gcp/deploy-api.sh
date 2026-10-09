#!/usr/bin/env bash
# Deploys the account API (server/src/api-main.ts) to Cloud Run as the service "api", from
# the committed code. It scales to zero; nowza.app/v2/* reaches it through Firebase Hosting
# (deploy-web.sh). Run setup-api.sh once first.
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
  echo "INVITE_BASE_URL: ${INVITE_BASE_URL:-https://nowza.app/i/}"
  # GET /v2/config's relay, and the contract's compatibility setting (contracts/README.md).
  # The apps only take a relay under nowza.app from it (ServiceConfigStore.approved).
  echo "RELAY_BASE_URL: https://${RELAY_PUBLIC_HOST:-relay-1.nowza.app}"
  if [ -n "${MINIMUM_BUILDS:-}" ]; then echo "MINIMUM_BUILDS: '${MINIMUM_BUILDS}'"; fi
  # The Test Bot's standing invite (server/src/accounts.ts): befriends the bot, and only the bot.
  if [ -n "${TEST_BOT_INVITE:-}" ]; then
    echo "TEST_BOT_USER_ID: \"$TEST_BOT_USER_ID\""
    echo "TEST_BOT_INVITE: \"$TEST_BOT_INVITE\""
  fi
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
  --service-account="account-api@$PROJECT_ID.iam.gserviceaccount.com" \
  --allow-unauthenticated --ingress=all \
  --min-instances=0 --max-instances=4 --cpu=1 --memory=512Mi --concurrency=80 --timeout=30s \
  --env-vars-file="$stage/env.yaml"

# The usage jobs (setup-stats.sh) and the Ops dashboard (setup-ops.sh) run from the same image,
# so they keep up with the API.
for job in stats stats-rolling; do
  if gc run jobs describe "$job" --region="$REGION" >/dev/null 2>&1; then
    gc run jobs update "$job" --image="$image" --region="$REGION" >/dev/null
    echo "The $job job uses $rev too."
  fi
done
if gc run services describe ops --region="$REGION" >/dev/null 2>&1; then
  gc run services update ops --image="$image" --region="$REGION" >/dev/null
  echo "The ops service uses $rev too."
fi

url=$(gc run services describe api --region="$REGION" --format='value(status.url)')
if curl -fsS --max-time 20 "$url/v2/health" | grep -q "\"revision\":\"$rev\""; then
  echo "$url serves $rev"
else
  echo "$url isn't serving $rev" >&2
  exit 1
fi
# The contract answers: its public config names relay protocol 2.
if curl -fsS --max-time 20 "$url/v2/config" | grep -q '"protocols":\[2\]'; then
  echo "$url serves /v2/config"
else
  echo "$url doesn't serve /v2/config" >&2
  exit 1
fi
