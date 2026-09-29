#!/usr/bin/env bash
# Archives the iPhone app (with the watch app and its notification service extension) in
# Release and uploads it to App Store Connect for internal TestFlight testing, with the App
# Store Connect API key in config.sh. Xcode's automatic signing makes the distribution
# certificate and profiles it needs through the same key.
#
#   deploy/appstore/testflight.sh [--notes "What to test"]
#
# The build number is the commit count (BUILD_NUMBER overrides it), so it rises with every
# commit; app/ must be committed, so a build always matches a commit. After the upload,
# asc.ts waits for Apple's processing and gives the build to the internal group.

set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
# shellcheck source=config.example.sh
source "$here/config.sh"
: "${ASC_KEY_ID:?Set ASC_KEY_ID in deploy/appstore/config.sh}"
: "${ASC_ISSUER_ID:?Set ASC_ISSUER_ID in deploy/appstore/config.sh}"
key=${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8}
[ -f "$key" ] || { echo "No API key at $key" >&2; exit 1; }

notes=""
if [ "${1:-}" = "--notes" ]; then notes=${2:-}; fi

if ! git -C "$repo" diff --quiet HEAD -- app; then
  echo "app/ has uncommitted changes. Commit them first, so the build matches a commit." >&2
  exit 1
fi
build=${BUILD_NUMBER:-$(git -C "$repo" rev-list --count HEAD)}
rev=$(git -C "$repo" rev-parse --short HEAD)
team=$(sed -n 's/^DEVELOPMENT_TEAM *= *//p' "$repo/app/Config/Local.xcconfig" | tr -d ' ')
[ -n "$team" ] || { echo "Set DEVELOPMENT_TEAM in app/Config/Local.xcconfig" >&2; exit 1; }
out="$repo/build/testflight/$build"
rm -rf "$out"
mkdir -p "$out"

auth=(-allowProvisioningUpdates -authenticationKeyPath "$key" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")

echo "Archiving build $build from $rev…"
xcodebuild -project "$repo/app/OverAndOut.xcodeproj" -scheme OverAndOut -configuration Release \
  -destination generic/platform=iOS -archivePath "$out/OverAndOut.xcarchive" \
  CURRENT_PROJECT_VERSION="$build" "${auth[@]}" -quiet archive

cat >"$out/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>destination</key>
	<string>upload</string>
	<key>teamID</key>
	<string>${team}</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>testFlightInternalTestingOnly</key>
	<true/>
	<key>manageAppVersionAndBuildNumber</key>
	<false/>
	<key>uploadSymbols</key>
	<true/>
</dict>
</plist>
EOF

echo "Uploading build $build to App Store Connect…"
xcodebuild -exportArchive -archivePath "$out/OverAndOut.xcarchive" -exportOptionsPlist "$out/ExportOptions.plist" \
  -exportPath "$out/export" "${auth[@]}" -quiet

echo "Uploaded build $build ($rev). Waiting for Apple's processing (usually 5–15 minutes)…"
node "$here/asc.ts" release "$build" ${notes:+--notes "$notes"}
