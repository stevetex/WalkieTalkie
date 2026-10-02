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

# Option E relay nodes: setup-uptime.sh emails alerts here (and setup-telemetry.sh's alerts).
ALERT_EMAIL="you@example.com"
# Accounts whose devices' whole timelines go to Cloud Logging, not only summaries
# (deploy-relay.sh): comma-separated account IDs, for measurement runs.
FULL_TIMELINE_USERS=""

# The always-on Test Bot (server/src/test-bot.ts), for App Review: its account ID (deploy-relay.sh:
# the relay answers its rings), and its standing invite's code (deploy-api.sh: the link
# https://overandout.app/i/<code> befriends the bot, any number of times). 12-64 letters, digits,
# "_" or "-"; generate one with: openssl rand -hex 12. Change it to stop new people adding the bot.
TEST_BOT_USER_ID=""
TEST_BOT_INVITE=""

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
# Optional, during the Beta: the public TestFlight link (App Store Connect → TestFlight →
# an external group → Public Link), e.g. https://testflight.apple.com/join/AbCd1234. While
# set, the invite page (overandout.app/i/<code>) offers "Join the beta on TestFlight";
# empty, it shows "Coming soon to the App Store". Redeploy the site after changing it.
TESTFLIGHT_URL=""

# The contract's compatibility setting (contracts/README.md; Phase 0 of
# ANDROID_WEAR_OS_PLAN.md), for deploy-api.sh and deploy-relay.sh:
# MINIMUM_BUILDS: JSON of the lowest build of each client kind still admitted, e.g.
# {"ios":170,"watchos":170}; older builds get "Update Over&Out". Empty = no minimum.
MINIMUM_BUILDS=""

# The relay GET /v2/config names (deploy-api.sh). It must be under overandout.app: the apps
# ignore any other host and use the one they were built with. Default relay-1.overandout.app.
RELAY_PUBLIC_HOST=""

# The Ops dashboard (OPS_DASHBOARD_SPEC.md; setup-ops.sh, setup-stats.sh). CANARY_USER_ID is the
# Canary account (node server/tools/test-account.ts canary prints it): every 15 minutes it talks
# to the Test Bot over the live relay, and it's left out of every usage number and live count.
# RELAY_NODES: the relay nodes the dashboard and the rolling job read /admin/stats from,
# comma-separated base URLs (default https://relay-1.overandout.app). OPS_URL: the dashboard's
# address once setup-ops.sh has deployed it (its run.app URL), for the links from the
# "Over&Out Beta" Monitoring dashboard and the alert emails (telemetry-monitoring.ts).
CANARY_USER_ID=""
RELAY_NODES=""
OPS_URL=""
# The dashboard's IAP OAuth client (setup-ops.sh): made in the console, under the "Over&Out"
# consent screen (APIs & Services → Credentials → Web application).
OPS_OAUTH_CLIENT_ID=""
OPS_OAUTH_CLIENT_SECRET=""
