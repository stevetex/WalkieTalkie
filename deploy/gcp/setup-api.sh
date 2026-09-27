#!/usr/bin/env bash
# One-time setup for the account API (design decisions 2026-09-27), after setup-firestore.sh
# and setup-relay.sh: the account-api service account, the session signing keys, the Sign in with
# Apple key, the invites TTL policy, and an email alert when a user files a report.
# Safe to re-run; existing resources are left alone (secrets aren't overwritten). Then
# deploy with deploy-api.sh, and redeploy the relay so nodes pick up the public keys.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
# shellcheck source-path=SCRIPTDIR source=config.example.sh
. "$here/config.sh"

api_sa="account-api@$PROJECT_ID.iam.gserviceaccount.com"
node_sa="relay-node@$PROJECT_ID.iam.gserviceaccount.com"
gc() { gcloud --project="$PROJECT_ID" --quiet "$@"; }

echo "Enabling Cloud Run…"
gc services enable run.googleapis.com

if ! gc iam service-accounts describe "$api_sa" >/dev/null 2>&1; then
  echo "Creating the account-api service account…"
  gc iam service-accounts create account-api --display-name="Over&Out account API"
fi
# A new service account can take a few seconds to be usable in IAM policies.
for attempt in 1 2 3 4 5 6; do
  if gc projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$api_sa" --role=roles/datastore.user --condition=None >/dev/null 2>&1; then
    break
  fi
  [ "$attempt" -lt 6 ] || { echo "Couldn't grant Firestore access to $api_sa." >&2; exit 1; }
  sleep 10
done

# create_secret <id>: the value comes on stdin and is never printed.
create_secret() {
  if gc secrets describe "$1" >/dev/null 2>&1; then
    cat >/dev/null
    return
  fi
  echo "Creating secret $1…"
  gc secrets create "$1" --replication-policy=user-managed --locations="$REGION" --data-file=- >/dev/null
}

# The session signing key (API only) and its public key (API and relay nodes). The pair is
# made in one go and only ever held in a variable.
have_private=$(gc secrets describe session-signing-key >/dev/null 2>&1 && echo yes || echo no)
have_public=$(gc secrets describe session-public-keys >/dev/null 2>&1 && echo yes || echo no)
if [ "$have_private" != "$have_public" ]; then
  echo "Only one of session-signing-key and session-public-keys exists; fix that by hand." >&2
  exit 1
fi
if [ "$have_private" = no ]; then
  keys=$(cd "$repo/server" && node tools/session-key.ts "k$(date +%Y%m%d)")
  node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(0, "utf8")).signingKey))' <<<"$keys" |
    create_secret session-signing-key
  node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(0, "utf8")).publicKeys))' <<<"$keys" |
    create_secret session-public-keys
  unset keys
fi

if [ -n "${APPLE_SIWA_KEY_FILE:-}" ]; then
  create_secret apple-siwa-key <"$APPLE_SIWA_KEY_FILE"
else
  echo "Note: APPLE_SIWA_KEY_FILE isn't set, so account deletion won't revoke Apple tokens yet." >&2
fi

for secret in session-signing-key session-public-keys apple-siwa-key; do
  if gc secrets describe "$secret" >/dev/null 2>&1; then
    gc secrets add-iam-policy-binding "$secret" --member="serviceAccount:$api_sa" \
      --role=roles/secretmanager.secretAccessor >/dev/null
  fi
done
gc secrets add-iam-policy-binding session-public-keys --member="serviceAccount:$node_sa" \
  --role=roles/secretmanager.secretAccessor >/dev/null

# Invites expire after 7 days; Firestore deletes them (the API also checks the date).
if ! gc firestore fields ttls list --format='value(name)' 2>/dev/null | grep -q 'collectionGroups/invites/fields/expireAt'; then
  echo "Adding the TTL policy on invites.expireAt…"
  gc firestore fields ttls update expireAt --collection-group=invites --enable-ttl --async
fi

# App Review 1.2: reports need a timely response. Each report logs a "[report]" line
# (server/src/api.ts), and this emails ALERT_EMAIL, at most once every 5 minutes.
if [ -n "${ALERT_EMAIL:-}" ]; then
  monitoring="https://monitoring.googleapis.com/v3/projects/$PROJECT_ID"
  auth() { printf 'Authorization: Bearer %s' "$(gcloud auth print-access-token)"; }
  channel=$(curl -fsS -H "$(auth)" "$monitoring/notificationChannels" |
    python3 -c "import json,sys; print(next((c['name'] for c in json.load(sys.stdin).get('notificationChannels', []) if c.get('labels', {}).get('email_address') == sys.argv[1]), ''))" "$ALERT_EMAIL")
  if [ -z "$channel" ]; then
    echo "Run setup-uptime.sh first (it creates the email notification channel)." >&2
    exit 1
  fi
  policy="Over&Out: user report"
  if [ -z "$(gc monitoring policies list --filter="displayName=\"$policy\"" --format='value(name)')" ]; then
    echo "Creating the report alert…"
    policy_file=$(mktemp)
    cat >"$policy_file" <<EOF
{
  "displayName": "$policy",
  "combiner": "OR",
  "conditions": [{
    "displayName": "A user reported another user",
    "conditionMatchedLog": {
      "filter": "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"api\" AND textPayload:\"[report]\""
    }
  }],
  "alertStrategy": { "notificationRateLimit": { "period": "300s" }, "autoClose": "1800s" },
  "notificationChannels": ["$channel"],
  "documentation": {
    "content": "Someone filed a report in Over&Out. The log line has the report ID. Review it in the Firestore console (reports collection, status open), and block or delete the reported account if needed.",
    "mimeType": "text/markdown"
  }
}
EOF
    gc monitoring policies create --policy-from-file="$policy_file" >/dev/null
    rm -f "$policy_file"
  fi
fi

echo "Account API setup done. Next: deploy/gcp/deploy-api.sh, then deploy/gcp/deploy-relay.sh."
