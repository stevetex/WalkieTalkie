#!/usr/bin/env bash
# The Beta telemetry's Google Cloud setup (the "Over&Out Beta telemetry spec" Claude Doc):
# TTL policies on the diagnostics and feedback collections, then the log-based metrics, the
# "Over&Out Beta" dashboard and the alert policies (telemetry-monitoring.ts). Safe to re-run:
# it updates what exists. Needs the email channel setup-uptime.sh creates.
#
#   deploy/gcp/setup-telemetry.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR source=config.example.sh
. "$here/config.sh"

gc() { gcloud --project="$PROJECT_ID" --quiet "$@"; }

# Devices' uploaded logs go after 30 days, problem reports after 90 (the privacy policy says so).
ttls=$(gc firestore fields ttls list --format='value(name)' 2>/dev/null || true)
for collection in diagnostics feedback; do
  if ! grep -q "collectionGroups/$collection/fields/expireAt" <<<"$ttls"; then
    echo "Adding the TTL policy on ${collection}.expireAt…"
    gc firestore fields ttls update expireAt --collection-group="$collection" --enable-ttl --async
  fi
done

PROJECT_ID="$PROJECT_ID" ALERT_EMAIL="${ALERT_EMAIL:-}" node "$here/telemetry-monitoring.ts" apply
