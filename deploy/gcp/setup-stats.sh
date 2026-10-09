#!/usr/bin/env bash
# The usage numbers, as Cloud Run jobs from the API's image, run as the API's service account
# (which also gets permission to read logs):
#   - "stats" (server/src/rollup-main.ts): the daily rollup, stats/{date}, then the Ops
#     dashboard's reports (reports-main.ts); Cloud Scheduler's "stats-daily" starts it at
#     00:30 UTC for the day before.
#   - "stats-rolling" (server/src/rolling-main.ts): the Ops dashboard's today-so-far numbers,
#     statsLive/{date}, and the Canary; Cloud Scheduler's "stats-rolling" starts it every 15
#     minutes (OPS_DASHBOARD_SPEC.md, "Rolling job").
# Safe to re-run: it updates both jobs to this commit's image and settings.
#
#   deploy/gcp/setup-stats.sh [commit]          (default: HEAD)
#   gcloud run jobs execute stats --region=us-central1 --args=src/rollup-main.ts,2026-09-29
#       runs it by hand for one day (the Scheduler job does yesterday)
#   gcloud run jobs execute stats-rolling --region=us-central1
#
# The Canary needs CANARY_USER_ID and TEST_BOT_USER_ID in config.sh (node server/tools/
# test-account.ts canary makes the account), and the relay's /admin/stats needs the
# ops-stats-token secret (setup-ops.sh); without them the rolling job runs without the Canary
# and the relay's peaks.
#
# Costs: about a minute of a Cloud Run job a day, plus 96 runs of under 30 s (inside the free
# tier); "stats-rolling" is the third of the three free Cloud Scheduler jobs per billing
# account (a fourth would cost about $0.10 a month).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR source=config.example.sh
. "$here/config.sh"

gc() { gcloud --project="$PROJECT_ID" --quiet "$@"; }
sa="account-api@$PROJECT_ID.iam.gserviceaccount.com"

echo "Enabling Cloud Scheduler…"
gc services enable cloudscheduler.googleapis.com

# Reading the day's telemetry entries back from Cloud Logging; the reports' Cost and quotas page
# reads Firestore's and Logging's usage from Cloud Monitoring.
for role in roles/logging.viewer roles/monitoring.viewer; do
  gc projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$sa" \
    --role="$role" --condition=None >/dev/null
done

# The summaries expire on their own: statsLive after 14 days, reports' history after 30.
ttls=$(gc firestore fields ttls list --format='value(name)' 2>/dev/null || true)
for collection in statsLive history; do
  if ! grep -q "collectionGroups/$collection/fields/expireAt" <<<"$ttls"; then
    echo "Adding the TTL policy on ${collection}.expireAt…"
    gc firestore fields ttls update expireAt --collection-group="$collection" --enable-ttl --async
  fi
done

umask 077
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
# Both jobs' settings. No secrets: the jobs read those from Secret Manager.
{
  if [ -n "${TEST_BOT_USER_ID:-}" ]; then echo "TEST_BOT_USER_ID: \"$TEST_BOT_USER_ID\""; fi
  if [ -n "${CANARY_USER_ID:-}" ]; then echo "CANARY_USER_ID: \"$CANARY_USER_ID\""; fi
  echo "RELAY_NODES: \"${RELAY_NODES:-https://relay-1.nowza.app}\""
  if [ -n "${MINIMUM_BUILDS:-}" ]; then echo "MINIMUM_BUILDS: '${MINIMUM_BUILDS}'"; fi
  # The relay's /admin/stats (the peaks), and the Canary's token.
  if gc secrets describe ops-stats-token >/dev/null 2>&1; then echo "OPS_STATS_TOKEN_SECRET: ops-stats-token"; fi
  if [ -n "${CANARY_USER_ID:-}" ]; then echo "SESSION_SIGNING_KEY_SECRET: session-signing-key"; fi
} >"$stage/env.yaml"
if gc secrets describe ops-stats-token >/dev/null 2>&1; then
  gc secrets add-iam-policy-binding ops-stats-token --member="serviceAccount:$sa" \
    --role=roles/secretmanager.secretAccessor >/dev/null
fi

image=$(IMAGE=api "$here/build-image.sh" "$@")
echo "Deploying the stats job ($image)…"
gc run jobs deploy stats --image="$image" --region="$REGION" --service-account="$sa" \
  --command=node --args=src/rollup-main.ts --env-vars-file="$stage/env.yaml" \
  --tasks=1 --max-retries=1 --task-timeout=900s --cpu=1 --memory=512Mi
echo "Deploying the stats-rolling job…"
gc run jobs deploy stats-rolling --image="$image" --region="$REGION" --service-account="$sa" \
  --command=node --args=src/rolling-main.ts --env-vars-file="$stage/env.yaml" \
  --tasks=1 --max-retries=0 --task-timeout=300s --cpu=1 --memory=512Mi

# The Scheduler jobs call the Run API as the same service account.
schedule() {
  local name=$1 job=$2 cron=$3 description=$4
  gc run jobs add-iam-policy-binding "$job" --region="$REGION" --member="serviceAccount:$sa" \
    --role=roles/run.invoker >/dev/null
  local uri="https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/$job:run"
  local verb=create
  if gc scheduler jobs describe "$name" --location="$REGION" >/dev/null 2>&1; then verb=update; fi
  gc scheduler jobs "$verb" http "$name" --location="$REGION" --schedule="$cron" --time-zone=UTC \
    --uri="$uri" --http-method=POST --oauth-service-account-email="$sa" --description="$description"
}
schedule stats-daily stats "30 0 * * *" "Nowza daily usage rollup (stats/{date}) and the Ops reports"
schedule stats-rolling stats-rolling "*/15 * * * *" "Nowza Ops: today-so-far numbers (statsLive/{date}) and the Canary"

echo "Stats jobs ready: the rollup at 00:30 UTC, the rolling numbers every 15 minutes."
echo "Read them with: node server/tools/beta.ts stats, or the Ops dashboard."
