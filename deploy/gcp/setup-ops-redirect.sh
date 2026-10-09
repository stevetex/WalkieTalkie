#!/usr/bin/env bash
# ops.nowza.app: a friendly address for the Nowza Ops dashboard. The dashboard itself
# stays on its run.app address behind IAP (a custom domain there would need a Cloud Run domain
# mapping, still preview, or a load balancer at about $18 a month); this is a second Firebase
# Hosting site, with no files, that sends every path there. $0. Safe to re-run: it releases the
# redirect again and prints the domain's DNS and certificate state.
#
#   deploy/gcp/setup-ops-redirect.sh          then add the DNS records it prints at GoDaddy
#   deploy/gcp/setup-ops-redirect.sh dns      the domain's DNS and certificate state
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR source=config.example.sh
. "$here/config.sh"

if [ -z "${OPS_URL:-}" ]; then echo "Set OPS_URL in config.sh first (setup-ops.sh prints it)." >&2; exit 1; fi
command=redirect
if [ "${1:-}" = dns ]; then command=dns; fi
PROJECT_ID="$PROJECT_ID" REGION="$REGION" SITE="${OPS_REDIRECT_SITE:-overandout-ops}" WEB_DOMAIN="${OPS_DOMAIN:-ops.nowza.app}" \
  REDIRECT_URL="$OPS_URL" node "$here/firebase-hosting.ts" "$command"
