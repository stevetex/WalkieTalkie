#!/usr/bin/env bash
# Monthly node replacement, so relay nodes get OS updates without a deploy. Nodes only pick
# up a newer Container-Optimized OS when they're recreated: the instance template names the
# image family (cos-stable), not an image, so each new node boots the family's newest image.
#
# A Cloud Scheduler job "node-replacement-monthly" starts a Cloud Run job "node-replacement"
# at 09:00 UTC on the 1st (2 am Pacific), which runs Google's gcloud image to do what
# deploy-relay.sh does, on the group's current template: replace the nodes one at a time
# (max surge 0, max unavailable 1, recreate), each coming back with the same name, IP and
# data disk, then wait until the group is stable. A node that doesn't come back healthy
# stops the rollout there, fails the execution (Cloud Run → Jobs → node-replacement) and
# trips the uptime alert. Safe to re-run: it updates what exists, and it replaces nothing.
#
# Why a Cloud Run job, not Scheduler calling the Compute API directly: a rolling replace is
# a PATCH whose version name must differ each time (gcloud stamps it with the time), which
# a Scheduler job's fixed body can't do; and applyUpdatesToInstances, which a fixed body
# can do, replaces every node at once instead of one at a time.
#
# Both jobs run as the node-replacer service account, which can only read and update
# instance groups (a custom role), use instance templates read-only, read zone operations,
# act as relay-node (the service account the nodes run as), and start this one Cloud Run job.
#
#   deploy/gcp/setup-node-replacement.sh
#   gcloud run jobs execute node-replacement --region=us-central1 --project=PROJECT_ID
#       replaces the nodes now (about 2 minutes of downtime per node)
#
# Costs: a few minutes of a Cloud Run job a month (inside its free tier) and the second of
# the three free Cloud Scheduler jobs per billing account.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR source=config.example.sh
. "$here/config.sh"

gc() { gcloud --project="$PROJECT_ID" --quiet "$@"; }
group=relay
job=node-replacement
schedule="0 9 1 * *"   # 09:00 UTC on the 1st: 2 am Pacific (1 am in winter), 5 am Eastern
sa_name=node-replacer
sa="$sa_name@$PROJECT_ID.iam.gserviceaccount.com"
node_sa="relay-node@$PROJECT_ID.iam.gserviceaccount.com"
role=relayNodeReplacer
role_permissions=compute.instanceGroupManagers.get,compute.instanceGroupManagers.update,compute.instanceTemplates.useReadOnly,compute.zoneOperations.get
# Google's gcloud image; Cloud Run pins the digest this tag has when the job is deployed.
image=gcr.io/google.com/cloudsdktool/google-cloud-cli:slim

echo "Enabling Cloud Run and Cloud Scheduler…"
gc services enable run.googleapis.com cloudscheduler.googleapis.com

if ! gc iam service-accounts describe "$sa" >/dev/null 2>&1; then
  echo "Creating the $sa_name service account…"
  gc iam service-accounts create "$sa_name" --display-name="Nowza monthly node replacement"
fi

# Only what a rolling replace and waiting on it need. roles/compute.instanceAdmin.v1 would
# also let it create, delete and SSH into any VM and disk in the project; instance groups
# have no per-group IAM policy, so the custom role is granted on the project (whose only
# group is relay).
role_state=$(gc iam roles describe "$role" --format='value(deleted)' 2>/dev/null || echo missing)
if [ "$role_state" = missing ]; then
  echo "Creating the $role role…"
  gc iam roles create "$role" --title="Nowza relay node replacer" \
    --description="Rolling-replace the relay instance group" --permissions="$role_permissions" --stage=GA >/dev/null
else
  # A role deleted within the last 7 days can't be re-created, only undeleted.
  if [ "$role_state" = True ]; then gc iam roles undelete "$role" >/dev/null; fi
  gc iam roles update "$role" --permissions="$role_permissions" >/dev/null
fi
# A new service account can take a few seconds to be usable in IAM policies.
for attempt in 1 2 3 4 5 6; do
  if gc projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$sa" \
    --role="projects/$PROJECT_ID/roles/$role" --condition=None >/dev/null 2>&1; then
    break
  fi
  [ "$attempt" -lt 6 ] || { echo "Couldn't grant the $role role to ${sa}." >&2; exit 1; }
  sleep 10
done
# Replacing nodes recreates them from the template, which runs them as relay-node, and
# Compute Engine checks that the caller may act as that account. Granted on relay-node
# only, not on the project.
gc iam service-accounts add-iam-policy-binding "$node_sa" --member="serviceAccount:$sa" \
  --role=roles/iam.serviceAccountUser >/dev/null

# What the job runs. Keep it free of commas: --args splits on them.
g="gcloud --project=$PROJECT_ID --quiet compute instance-groups managed"
script="set -eu"
# Let a deploy that's in progress finish first.
script="$script && $g wait-until $group --zone=$ZONE --stable --timeout=900"
script="$script && $g rolling-action replace $group --zone=$ZONE --max-surge=0 --max-unavailable=1 --replacement-method=recreate"
script="$script && $g wait-until $group --zone=$ZONE --stable --timeout=2400"
script="$script && $g list-instances $group --zone=$ZONE"

echo "Deploying the $job job…"
gc run jobs deploy "$job" --image="$image" --region="$REGION" --service-account="$sa" \
  --command=bash --args="-c,$script" \
  --tasks=1 --max-retries=0 --task-timeout=3600s --cpu=1 --memory=512Mi

# The Scheduler job calls the Run API as the same service account.
gc run jobs add-iam-policy-binding "$job" --region="$REGION" --member="serviceAccount:$sa" \
  --role=roles/run.invoker >/dev/null
uri="https://run.googleapis.com/v2/projects/$PROJECT_ID/locations/$REGION/jobs/$job:run"
if gc scheduler jobs describe "$job-monthly" --location="$REGION" >/dev/null 2>&1; then
  verb=update
else
  verb=create
fi
gc scheduler jobs "$verb" http "$job-monthly" --location="$REGION" --schedule="$schedule" --time-zone=UTC \
  --uri="$uri" --http-method=POST --oauth-service-account-email="$sa" \
  --description="Nowza: replace relay nodes one at a time, for the newest Container-Optimized OS"

echo "Node replacement ready: the $group nodes are replaced at 09:00 UTC on the 1st of each month."
echo "Runs: gcloud run jobs executions list --job=$job --region=$REGION --project=$PROJECT_ID"
