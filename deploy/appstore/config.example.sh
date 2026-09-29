# Copy to config.sh (gitignored) and fill in. From App Store Connect → Users and Access →
# Integrations → App Store Connect API → Team Keys.

# The key's ID (10 characters) and the issuer ID shown above the list of keys.
ASC_KEY_ID=""
ASC_ISSUER_ID=""

# The downloaded .p8. Default: ~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8, where
# Apple's tools also look. Keep it out of the repository and readable only by you.
# ASC_KEY_PATH=""

# The internal TestFlight group that gets every build.
ASC_GROUP="House"
