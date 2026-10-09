#!/usr/bin/env bash
# nowza.app on Firebase Hosting: the apple-app-site-association file, the invite fallback
# page, and the home, privacy and support pages from web/public, with nowza.app/v2/* going to
# the account API on Cloud Run.
#
#   deploy/gcp/deploy-web.sh setup    once: adds Firebase to the project, creates the site
#                                     and the custom domain (WEB_DOMAIN, default nowza.app),
#                                     and prints the DNS records it needs
#   deploy/gcp/deploy-web.sh dns      the domain's DNS and certificate state
#   deploy/gcp/deploy-web.sh          uploads web/public and releases it (the invite page
#                                     offers TestFlight while config.sh sets TESTFLIGHT_URL)
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
# TESTFLIGHT_URL, while set, puts "Join the beta on TestFlight" on the invite page instead
# of "Coming soon to the App Store".
PROJECT_ID="$PROJECT_ID" REGION="$REGION" TEAM_ID="${APPLE_TEAM_ID:-$APNS_TEAM_ID}" SUPPORT_EMAIL="${SUPPORT_EMAIL:-}" \
  TESTFLIGHT_URL="${TESTFLIGHT_URL:-}" node "$here/firebase-hosting.ts" "${1:-deploy}"
