# shellcheck shell=bash disable=SC2034
# Copy to config.sh (gitignored) and fill in. Sourced by the setup and deploy scripts.

PROJECT_ID="your-gcp-project-id"

# The e2-micro free tier only covers us-west1, us-central1 and us-east1.
REGION="us-central1"
ZONE="us-central1-a"

# Optional: Let's Encrypt sends certificate expiry notices here.
ACME_EMAIL="you@example.com"

# Shared bearer token for the API and relay; must match SPIKE_TOKEN in the watch's
# Local.xcconfig. Generate one with: openssl rand -hex 24
SPIKE_TOKEN=""

# APNs token auth. Leave empty until your Apple Developer Program membership is
# active; the server then runs with dry-run pushes (no-push watches still work).
APNS_KEY_FILE=""   # local path to AuthKey_XXXXXXXXXX.p8
APNS_KEY_ID=""
APNS_TEAM_ID=""
APNS_BUNDLE_ID=""  # must match the watch app's bundle ID

# Option E relay nodes: setup-uptime.sh emails alerts here.
ALERT_EMAIL="you@example.com"
