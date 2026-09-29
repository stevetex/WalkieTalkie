#!/usr/bin/env bash
# The daily usage rollup (the Beta telemetry spec's "Usage analytics"): a Cloud Run job "stats"
# that runs server/src/rollup-main.ts from the API's image, and a Cloud Scheduler job
# "stats-daily" that starts it at 00:30 UTC for the day before. The job runs as the API's
# service account, which also gets permission to read logs. Safe to re-run: it updates the
# job to this commit's image.
#
#   deploy/gcp/setup-stats.sh [commit]          (default: HEAD)
#   gcloud run jobs execute stats --region=us-central1 --args=src/rollup-main.ts,2026-09-29
#       runs it by hand for one day (the Scheduler job does yesterday)
#
# Costs: about a minute of a Cloud Run job a day (inside its free tier) and one of the three
# free Cloud Scheduler jobs per billing account.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR source=config.example.sh
. "$here/config.sh"

gc() { gcloud --project="$PROJECT_ID" --quiet "$@"; }
sa="account-api@$PROJECT_ID.iam.gserviceaccount.com"

echo "Enabling Cloud Scheduler…"
gc services enable cloudscheduler.googleapis.com

# Reading the day's telemetry entries back from Cloud Logging.
gc projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$sa" \
  --role=roles/logging.viewer --condition=None >/dev/null

image=$(IMAGE=api "$here/build-image.sh" "$@")
echo "Deploying the stats job ($image)…"
gc run jobs deploy stats --image="$image" --region="$REGION" --service-account="$sa" \
  --command=node --args=src/rollup-main.ts \
  --tasks=1 --max-retries=1 --task-timeout=600s --cpu=1 --memory=512Mi

# The Scheduler job calls the Run API as the same service account.
gc run jobs add-iam-policy-binding stats --region="$REGION" --member="serviceAccount:$sa" \
  --role=roles/run.invoker >/dev/null
uri="https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/stats:run"
if gc scheduler jobs describe stats-daily --location="$REGION" >/dev/null 2>&1; then
  verb=update
else
  verb=create
fi
gc scheduler jobs "$verb" http stats-daily --location="$REGION" --schedule="30 0 * * *" --time-zone=UTC \
  --uri="$uri" --http-method=POST --oauth-service-account-email="$sa" \
  --description="Over&Out daily usage rollup (stats/{date})"

echo "Stats job ready: it runs daily at 00:30 UTC. Read the results with: node server/tools/beta.ts stats"
