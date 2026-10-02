#!/usr/bin/env bash
# Who can open the Over&Out Ops dashboard: Google accounts (Gmail included) or a Google Group,
# granted IAP's "IAP-secured Web App User" on the ops service (OPS_DASHBOARD_SPEC.md, "Sign-in
# and access"). Changes take effect within a minute or so.
#
#   deploy/gcp/ops-access.sh add <email>          a person
#   deploy/gcp/ops-access.sh add group:<email>    a Google Group: then manage people in the group
#   deploy/gcp/ops-access.sh remove <email>
#   deploy/gcp/ops-access.sh list
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR source=config.example.sh
. "$here/config.sh"

gc() { gcloud --project="$PROJECT_ID" --quiet "$@"; }
target=(--resource-type=cloud-run --service=ops --region="$REGION")
role=roles/iap.httpsResourceAccessor

member() {
  case "$1" in
    group:* | user:* | domain:*) echo "$1" ;;
    *@*) echo "user:$1" ;;
    *) echo "not an email address: $1" >&2; exit 2 ;;
  esac
}

case "${1:-}" in
  add)
    [ -n "${2:-}" ] || { echo "usage: $0 add <email | group:email>" >&2; exit 2; }
    gc iap web add-iam-policy-binding --member="$(member "$2")" --role="$role" "${target[@]}" >/dev/null
    echo "$2 can open the dashboard${OPS_URL:+: $OPS_URL}"
    ;;
  remove)
    [ -n "${2:-}" ] || { echo "usage: $0 remove <email | group:email>" >&2; exit 2; }
    gc iap web remove-iam-policy-binding --member="$(member "$2")" --role="$role" "${target[@]}" >/dev/null
    echo "$2 can no longer open the dashboard"
    ;;
  list)
    gc iap web get-iam-policy "${target[@]}" --flatten='bindings[].members' \
      --filter="bindings.role=$role" --format='value(bindings.members)'
    ;;
  *)
    echo "usage: $0 add <email> | remove <email> | list" >&2
    exit 2
    ;;
esac
