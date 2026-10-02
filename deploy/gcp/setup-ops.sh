#!/usr/bin/env bash
# The Over&Out Ops dashboard (OPS_DASHBOARD_SPEC.md): the Cloud Run service "ops" behind
# Identity-Aware Proxy, its service account "ops-viewer", and the relay's ops-stats-token.
# Safe to re-run: it updates the service to this commit's image and settings.
#
#   deploy/gcp/setup-ops.sh [commit]          (default: HEAD)
#
# Before the first run, Steve sets up in the console (the project has no organization, so IAP
# can't use Google's managed OAuth client and the client can't be made from the command line):
#   1. APIs & Services → OAuth consent screen: External, app name "Over&Out", support email
#      support@cypressoakstudios.com, privacy policy https://overandout.app/privacy, scopes
#      name, email and profile only, no logo; publishing status In production.
#   2. APIs & Services → Credentials → OAuth client ID → Web application, "Over&Out Ops (IAP)".
#      Then put its ID and secret in config.sh as OPS_OAUTH_CLIENT_ID and OPS_OAUTH_CLIENT_SECRET
#      (never printed; passed to IAP's settings below).
# Then grant people with ops-access.sh. After this, redeploy the relay (deploy-relay.sh) so it
# reads the new token, and re-run setup-stats.sh so the rolling job does too.
#
# Costs: $0. Cloud Run scales to zero (CPU only during requests, at most one instance); IAP on
# Cloud Run is free; the secret is about $0.06 a month once the project has more than six
# active secret versions.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR source=config.example.sh
. "$here/config.sh"

gc() { gcloud --project="$PROJECT_ID" --quiet "$@"; }
sa_name=ops-viewer
sa="$sa_name@$PROJECT_ID.iam.gserviceaccount.com"
project_number=$(gc projects describe "$PROJECT_ID" --format='value(projectNumber)')

if [ -z "${OPS_OAUTH_CLIENT_ID:-}" ] || [ -z "${OPS_OAUTH_CLIENT_SECRET:-}" ]; then
  echo "Set OPS_OAUTH_CLIENT_ID and OPS_OAUTH_CLIENT_SECRET in config.sh first (the console steps above)." >&2
  exit 1
fi

echo "Enabling IAP…"
gc services enable iap.googleapis.com

if ! gc iam service-accounts describe "$sa" >/dev/null 2>&1; then
  echo "Creating the $sa_name service account…"
  gc iam service-accounts create "$sa_name" --display-name="Over&Out Ops dashboard (read-only)"
fi
# Read Firestore and Cloud Monitoring; nothing else in the project.
for role in roles/datastore.viewer roles/monitoring.viewer; do
  gc projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$sa" --role="$role" --condition=None >/dev/null
done
# Regenerate: start the stats job with one report's ID, and only that job.
if gc run jobs describe stats --region="$REGION" >/dev/null 2>&1; then
  gc run jobs add-iam-policy-binding stats --region="$REGION" --member="serviceAccount:$sa" \
    --role=roles/run.jobsExecutorWithOverrides >/dev/null
else
  echo "Note: no stats job yet (setup-stats.sh); Regenerate won't work until it exists and this runs again." >&2
fi

# The relay's /admin/stats token: opens only that route (server/src/main.ts). Held in a variable
# so a failure can't create an empty secret; never printed.
if ! gc secrets describe ops-stats-token >/dev/null 2>&1; then
  echo "Creating the ops-stats-token secret…"
  token=$(openssl rand -hex 24)
  printf %s "$token" | gc secrets create ops-stats-token --replication-policy=user-managed --locations="$REGION" --data-file=- >/dev/null
  unset token
fi
# The dashboard, the relay nodes and the rolling job read it.
for member in "serviceAccount:$sa" "serviceAccount:relay-node@$PROJECT_ID.iam.gserviceaccount.com" "serviceAccount:account-api@$PROJECT_ID.iam.gserviceaccount.com"; do
  gc secrets add-iam-policy-binding ops-stats-token --member="$member" --role=roles/secretmanager.secretAccessor >/dev/null
done

image=$(IMAGE=api "$here/build-image.sh" "$@")
rev=${image##*:}

umask 077
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
{
  echo "OPS_STATS_TOKEN_SECRET: ops-stats-token"
  echo "RELAY_NODES: \"${RELAY_NODES:-https://relay-1.overandout.app}\""
  echo "REGION: $REGION"
  echo "MONITORING_DASHBOARD: \"${MONITORING_DASHBOARD:-https://console.cloud.google.com/monitoring/dashboards?project=$PROJECT_ID}\""
} >"$stage/env.yaml"

echo "Deploying $image as the ops service (behind IAP)…"
# No unauthenticated access: requests reach the service only through IAP's Google sign-in
# (https://docs.cloud.google.com/run/docs/securing/identity-aware-proxy-cloud-run).
gc run deploy ops --image="$image" --region="$REGION" --service-account="$sa" \
  --command=node --args=src/ops-main.ts --env-vars-file="$stage/env.yaml" \
  --no-allow-unauthenticated --iap \
  --min-instances=0 --max-instances=1 --cpu=1 --memory=256Mi --cpu-throttling --concurrency=40 --timeout=30s

# IAP calls the service as its service agent, which Cloud Run checks.
gc run services add-iam-policy-binding ops --region="$REGION" \
  --member="serviceAccount:service-$project_number@gcp-sa-iap.iam.gserviceaccount.com" --role=roles/run.invoker >/dev/null

# The custom OAuth client, not Google's managed one, which needs an organization
# (https://docs.cloud.google.com/iap/docs/custom-oauth-configuration).
cat >"$stage/iap-oauth.yaml" <<YAML
accessSettings:
  oauthSettings:
    clientId: ${OPS_OAUTH_CLIENT_ID}
    clientSecret: ${OPS_OAUTH_CLIENT_SECRET}
YAML
gc iap settings set "$stage/iap-oauth.yaml" --resource-type=cloud-run --region="$REGION" --service=ops >/dev/null

url=$(gc run services describe ops --region="$REGION" --format='value(status.url)')
echo "Ops runs $rev at $url"
echo "Set OPS_URL=\"$url\" in config.sh, then grant people: deploy/gcp/ops-access.sh add <email>"
echo "Then link the dashboards: node deploy/gcp/telemetry-monitoring.ts apply (with OPS_URL set)."
