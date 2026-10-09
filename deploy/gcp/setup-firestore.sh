#!/usr/bin/env bash
# One-time setup for option E's server data: the Firestore database, its TTL policy, and
# the service account the relay nodes run as. Safe to re-run; existing resources are
# left alone.
#
# The database's location can't be changed later (design decision 2026-09-26: us-central1).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR source=config.example.sh
. "$here/config.sh"

FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-us-central1}"
NODE_SA="relay-node"
node_sa_email="$NODE_SA@$PROJECT_ID.iam.gserviceaccount.com"

gc() { gcloud --project="$PROJECT_ID" --quiet "$@"; }

echo "Enabling the Firestore API…"
gc services enable firestore.googleapis.com

if ! gc firestore databases describe --database='(default)' >/dev/null 2>&1; then
  echo "Creating the (default) Firestore database in ${FIRESTORE_LOCATION}…"
  # Standard edition, Native mode (the free quota applies to it), protected from deletion.
  gc firestore databases create --database='(default)' --location="$FIRESTORE_LOCATION" \
    --type=firestore-native --edition=standard --delete-protection
fi

# Metrics timelines expire 30 days after they're written (see FirestoreMetricsStore).
if ! gc firestore fields ttls list --format='value(name)' 2>/dev/null | grep -q 'collectionGroups/timelines/fields/expireAt'; then
  echo "Adding the TTL policy on timelines.expireAt…"
  gc firestore fields ttls update expireAt --collection-group=timelines --enable-ttl --async
fi

if ! gc iam service-accounts describe "$node_sa_email" >/dev/null 2>&1; then
  echo "Creating the $NODE_SA service account…"
  gc iam service-accounts create "$NODE_SA" --display-name="Nowza relay node"
fi

# Firestore read/write, plus logs and metrics from the node's agents.
for role in roles/datastore.user roles/logging.logWriter roles/monitoring.metricWriter; do
  gc projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$node_sa_email" --role="$role" --condition=None >/dev/null
done

echo "Firestore ready in $FIRESTORE_LOCATION; relay nodes run as $node_sa_email."
