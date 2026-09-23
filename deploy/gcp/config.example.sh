# shellcheck shell=bash disable=SC2034
# Copy to config.sh (gitignored) and fill in. Sourced by create-vm.sh and deploy.sh.

PROJECT_ID="your-gcp-project-id"

# The e2-micro free tier only covers us-west1, us-central1 and us-east1.
REGION="us-central1"
ZONE="us-central1-a"
VM_NAME="walkie-relay"

# Hostname the watch connects to. Point a DNS A record at the VM's static IP.
DOMAIN="walkie.example.com"
# Let's Encrypt sends certificate expiry notices here.
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
