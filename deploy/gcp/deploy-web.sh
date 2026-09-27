#!/usr/bin/env bash
# overandout.app on Firebase Hosting: the apple-app-site-association file, the invite
# fallback page, and the home, privacy and support pages from web/public, with
# overandout.app/v1/* going to the account API on Cloud Run.
#
#   deploy/gcp/deploy-web.sh setup    once: adds Firebase to the project, creates the site
#                                     and the custom domain, and prints GoDaddy's DNS records
#   deploy/gcp/deploy-web.sh dns      the domain's DNS and certificate state
#   deploy/gcp/deploy-web.sh          uploads web/public and releases it
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR source=config.example.sh
. "$here/config.sh"

if [ "${1:-deploy}" = setup ]; then
  gcloud --project="$PROJECT_ID" --quiet services enable firebase.googleapis.com firebasehosting.googleapis.com
fi
if [ "${1:-deploy}" = deploy ] && [ -z "${SUPPORT_EMAIL:-}" ]; then
  echo "Set SUPPORT_EMAIL in config.sh first (shown on the privacy and support pages)." >&2
  exit 1
fi
PROJECT_ID="$PROJECT_ID" REGION="$REGION" TEAM_ID="${APPLE_TEAM_ID:-$APNS_TEAM_ID}" SUPPORT_EMAIL="${SUPPORT_EMAIL:-}" \
  node "$here/firebase-hosting.ts" "${1:-deploy}"
