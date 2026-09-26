# Over&Out app

The product: an iPhone companion app and an Apple Watch app. The relay is in [`../server`](../server). The spike this replaces is in [`../watch`](../watch).

```
OverAndOut.xcodeproj    Hand-written project; iOS/ and Watch/ are synchronized folders,
                        so new files are picked up without editing the project
iOS/                    iPhone app (iOS 16+): sign-in, invites, friends, settings
Watch/                  Watch app (watchOS 9+), embedded in the iPhone app
Packages/OverAndOutKit  Shared code: relay transport, voice codec, audio pipeline
Config/                 xcconfigs, the watch's Info.plist additions and entitlements
```

## Setup

Copy `Config/Local.xcconfig.example` to `Config/Local.xcconfig` (gitignored) and set `DEVELOPMENT_TEAM`.

- **Bundle IDs:** `com.cypressoakstudios.overandout`, and `com.cypressoakstudios.overandout.watchkitapp` for the watch.
- **Before the paid membership is active:** sign with the free Personal Team, and set `OAO_PUSH = no` and `OAO_BUNDLE_ID = com.cypressoakstudios.overandout.dev`. Automatic signing registers the bundle ID with whichever team signs, so a Personal Team mustn't claim the real one.
- **With the paid team:** leave both unset. The watch then gets the Push Notifications and Time Sensitive Notifications entitlements. The watch registers for pushes itself, so the server's `APNS_BUNDLE_ID` (the APNs topic) must be the watch app's ID, `com.cypressoakstudios.overandout.watchkitapp`.

## Build and test

```bash
xcodebuild -project OverAndOut.xcodeproj -scheme OverAndOut -destination 'generic/platform=iOS Simulator' build
```

Building the `OverAndOut` scheme also builds the watch app and embeds it. To run on the watch simulator, install `OverAndOutWatch.app` from `Debug-watchsimulator` with `xcrun simctl install`.

To test the whole ring → tap → join path in the watch simulator without an APNs key, run a local relay with `SIMULATOR_PUSH=1` (see "Simulator" in [HANDOFF.md](../HANDOFF.md)). Build with `OAO_SERVER_HOST=localhost:8080 OAO_SERVER_TOKEN=<the local relay's token>`.

The shared package's tests run on the Mac:

```bash
cd Packages/OverAndOutKit && swift test
```

Never measure timing under Xcode's debugger on the watch (see [HANDOFF.md](../HANDOFF.md), Gotchas).
