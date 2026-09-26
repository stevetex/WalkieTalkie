#!/usr/bin/env bash
# Uptime checks on each relay hostname's /healthz, and an email alert to ALERT_EMAIL when
# one fails from two or more regions for 5 minutes. Safe to re-run.
#
#   deploy/gcp/setup-uptime.sh relay-1.overandout.app [more hosts…]
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR source=config.example.sh
. "$here/config.sh"

[ $# -gt 0 ] || { echo "usage: setup-uptime.sh HOST [HOST…]" >&2; exit 2; }
[ -n "${ALERT_EMAIL:-}" ] || { echo "Set ALERT_EMAIL in config.sh first." >&2; exit 1; }
gc() { gcloud --project="$PROJECT_ID" --quiet "$@"; }
api="https://monitoring.googleapis.com/v3/projects/$PROJECT_ID"
auth() { printf 'Authorization: Bearer %s' "$(gcloud auth print-access-token)"; }

# The email channel. gcloud only has this in its beta component, so use the REST API.
channel=$(curl -fsS -H "$(auth)" "$api/notificationChannels" |
  python3 -c "import json,sys; print(next((c['name'] for c in json.load(sys.stdin).get('notificationChannels', []) if c.get('labels', {}).get('email_address') == sys.argv[1]), ''))" "$ALERT_EMAIL")
if [ -z "$channel" ]; then
  echo "Creating the email notification channel…"
  channel=$(curl -fsS -X POST -H "$(auth)" -H 'content-type: application/json' "$api/notificationChannels" \
    -d "{\"type\":\"email\",\"displayName\":\"Relay alerts\",\"labels\":{\"email_address\":\"$ALERT_EMAIL\"}}" |
    python3 -c "import json,sys; print(json.load(sys.stdin)['name'])")
fi

for host in "$@"; do
  name="relay $host"
  check=$(gc monitoring uptime list-configs --filter="displayName=\"$name\"" --format='value(name)' | head -1)
  if [ -z "$check" ]; then
    echo "Creating the uptime check for https://$host/healthz…"
    gc monitoring uptime create "$name" --resource-type=uptime-url \
      --resource-labels="host=$host,project_id=$PROJECT_ID" --protocol=https --path=/healthz \
      --period=1 --timeout=10 --validate-ssl=true \
      --regions=usa-iowa,usa-oregon,usa-virginia >/dev/null
    check=$(gc monitoring uptime list-configs --filter="displayName=\"$name\"" --format='value(name)' | head -1)
  fi
  check_id=${check##*/}

  policy="Relay down: $host"
  if [ -z "$(gc monitoring policies list --filter="displayName=\"$policy\"" --format='value(name)')" ]; then
    echo "Creating the alert policy for $host…"
    policy_file=$(mktemp)
    cat >"$policy_file" <<EOF
{
  "displayName": "$policy",
  "combiner": "OR",
  "conditions": [{
    "displayName": "https://$host/healthz failing",
    "conditionThreshold": {
      "filter": "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"$check_id\"",
      "aggregations": [{
        "alignmentPeriod": "60s",
        "perSeriesAligner": "ALIGN_NEXT_OLDER",
        "crossSeriesReducer": "REDUCE_COUNT_FALSE",
        "groupByFields": ["resource.label.host"]
      }],
      "comparison": "COMPARISON_GT",
      "thresholdValue": 1,
      "duration": "300s",
      "trigger": { "count": 1 }
    }
  }],
  "documentation": {
    "content": "The relay at https://$host/healthz has failed its uptime check from two or more regions for 5 minutes. The instance group should have recreated it; check with: gcloud compute instance-groups managed list-instances relay --zone=$ZONE --project=$PROJECT_ID",
    "mimeType": "text/markdown"
  },
  "notificationChannels": ["$channel"]
}
EOF
    gc monitoring policies create --policy-from-file="$policy_file" >/dev/null
    rm -f "$policy_file"
  fi
  echo "$host: uptime check $check_id, alerts to $ALERT_EMAIL"
done
