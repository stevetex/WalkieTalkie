# shellcheck shell=bash disable=SC2034
# Copy to config.sh (gitignored) and fill in. Sourced by the setup and deploy scripts.

PROJECT_ID="your-gcp-project-id"

# The e2-micro free tier only covers us-west1, us-central1 and us-east1.
REGION="us-central1"
ZONE="us-central1-a"

# Optional: Let's Encrypt sends certificate expiry notices here.
ACME_EMAIL="you@example.com"

# Bearer token for the relay's diagnostics (timelines, status), used by tools/report.ts and
# bot.ts --ring-until-answered. Generate one with: openssl rand -hex 24
SPIKE_TOKEN=""

# APNs token auth. Leave empty until your Apple Developer Program membership is
# active; the server then runs with dry-run pushes (no-push watches still work).
APNS_KEY_FILE=""   # local path to AuthKey_XXXXXXXXXX.p8
APNS_KEY_ID=""
APNS_TEAM_ID=""
APNS_BUNDLE_ID=""  # must match the watch app's bundle ID

# Option E relay nodes: setup-uptime.sh emails alerts here.
ALERT_EMAIL="you@example.com"

# The account API (setup-api.sh, deploy-api.sh). APPLE_TEAM_ID defaults to APNS_TEAM_ID.
# The Sign in with Apple key revokes a user's Apple tokens when they delete their account:
# developer portal → Keys → + → Sign in with Apple, configured for the iPhone app's App ID.
APPLE_SIWA_KEY_FILE=""   # local path to that AuthKey_XXXXXXXXXX.p8
APPLE_SIWA_KEY_ID=""
APPLE_TEAM_ID=""
# Bundle IDs whose Sign in with Apple tokens the API accepts; the first is the client ID
# for revocation.
APPLE_AUDIENCES="com.cypressoakstudios.overandout"

# overandout.app (deploy-web.sh): the contact address on the privacy and support pages.
SUPPORT_EMAIL=""
