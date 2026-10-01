# Over&Out app

The product: an iPhone companion app and an Apple Watch app. The relay is in [`../server`](../server). The spike this replaces is in [`../watch`](../watch).

```
OverAndOut.xcodeproj    Hand-written project; iOS/ and Watch/ are synchronized folders,
                        so new files are picked up without editing the project
iOS/                    iPhone app (iOS 17+): Sign in with Apple, onboarding (name, Focus,
                        watch), friends, invites, block and report, settings, account deletion
Watch/                  Watch app (watchOS 10.2+), embedded in the iPhone app
WatchNotificationService/  The watch's notification service extension (ring prefetch)
Packages/OverAndOutKit  Shared code: accounts (session, Keychain, API client), relay
                        transport, voice codec, audio pipeline
Config/                 xcconfigs, the watch's Info.plist additions and entitlements
```

## Setup

Copy `Config/Local.xcconfig.example` to `Config/Local.xcconfig` (gitignored) and set `DEVELOPMENT_TEAM`.

- **Bundle IDs:** `com.cypressoakstudios.overandout`, and `com.cypressoakstudios.overandout.watchkitapp` for the watch.
- **Before the paid membership is active:** sign with the free Personal Team, and set `OAO_PUSH = no` and `OAO_BUNDLE_ID = com.cypressoakstudios.overandout.dev`. Automatic signing registers the bundle ID with whichever team signs, so a Personal Team mustn't claim the real one.
- **With the paid team:** leave both unset. The watch then gets the Push Notifications and Time Sensitive Notifications entitlements. The watch registers for pushes itself, so the server's `APNS_BUNDLE_ID` (the APNs topic) must be the watch app's ID, `com.cypressoakstudios.overandout.watchkitapp`. The iPhone app has Sign in with Apple and Associated Domains (`applinks:overandout.app`), which Xcode's automatic signing adds to the App ID.
- **Servers:** `OAO_SERVER_HOST` is the relay (relay-1.overandout.app) and `OAO_API_HOST` the account API (overandout.app, which Firebase Hosting forwards to Cloud Run). Builds hold no secrets: each device gets its own session token.

## Accounts

- The iPhone signs in with Apple (with a nonce) and gets a 30-day session token for itself. The watch gets its own session from the iPhone over WatchConnectivity (`iOS/PhoneWatchLink.swift`, `Watch/WatchAccount.swift`): it asks with its device ID, and the iPhone makes the session with the API. After that the watch refreshes its token itself.
- Tokens live in the Keychain. The watch's is under the app group, so the notification service extension can prefetch with it.
- Invite links (`https://overandout.app/i/<code>`) open the iPhone app, which asks before adding the friend. Signing out on the iPhone signs the watch out too.

## Build and test

```bash
xcodebuild -project OverAndOut.xcodeproj -scheme OverAndOut -destination 'generic/platform=iOS Simulator' build
```

Building the `OverAndOut` scheme also builds the watch app and embeds it. To run on the watch simulator, install `OverAndOutWatch.app` from `Debug-watchsimulator` with `xcrun simctl install`.

To test in simulators without Apple or an APNs key, run a local relay that also serves the API and accepts dev sign-ins (see "Simulator" in [HANDOFF.md](../HANDOFF.md)), and build with `OAO_SERVER_HOST=localhost:8080 OAO_API_HOST=localhost:8080`. Debug builds against a local API show a "Test user" sign-in on the iPhone, and the watch signs in as a dev user when launched with `SIMCTL_CHILD_OAO_DEV_USER=<name>`, since WatchConnectivity doesn't work in the Xcode 27 simulators here.

The shared package's tests run on the Mac:

```bash
cd Packages/OverAndOutKit && swift test
```

`swift test --sanitize=thread` runs them under Thread Sanitizer too.

## Swift 6

Everything is in the Swift 6 language mode (2026-09-29; [SWIFT6_MIGRATION_PLAN.md](../SWIFT6_MIGRATION_PLAN.md)): `SWIFT_VERSION = 6.0` for all three targets in Debug and Release, and `.swiftLanguageMode(.v6)` for the package and its tests. Default main-actor isolation and the Approachable Concurrency switches are off. The builds are clean of warnings; keep them that way.

Who owns what:
- **Main actor:** `RelayConnection` (its URLSession delegate methods are nonisolated and hop in), `AudioPipeline`'s API and callbacks, and the controllers and account objects in both apps.
- **`AudioPipeline`'s audio queue** (`AudioQueueState`): the codec, the capture and jitter buffers, and scheduling on the player. The input tap's block owns the capture converter.
- **Locks** (`OSAllocatedUnfairLock`): `Telemetry`, the session stores, and the notification extension's request (delivered once, by the download or the expiry, whichever comes first).

The unchecked boundaries left, each with its invariant in a comment: `AudioQueueState` (queue-confined), the extension's `Delivery` and `PhoneWatchLink.Reply` (framework handlers without Sendable annotations, called once), and the test stubs' URLProtocol subclasses.

A closure written inside a main-actor type is main-actor too, unless its parameter type is `@Sendable`, and Swift 6 traps at run time if a framework calls it on another thread. Mark such closures `@Sendable` (`DispatchSource.setEventHandler`, `WCSession.sendMessage`'s handlers and `AVAudioSession.requestRecordPermission` need it), make delegate methods on main-actor types `nonisolated`, and use `MainActor.assumeIsolated` in callbacks delivered on the main queue (`NotificationCenter` with `queue: .main`, `Timer`).

To check a change, from fresh build output:

```bash
xcodebuild -project OverAndOut.xcodeproj -scheme OverAndOut -configuration Debug -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/oao-debug build
```

```bash
xcodebuild -project OverAndOut.xcodeproj -scheme OverAndOut -configuration Release -destination 'generic/platform=iOS' -derivedDataPath /tmp/oao-release CODE_SIGNING_ALLOWED=NO build
```

Both should print no `warning:` or `error:` lines, apart from `appintentsmetadataprocessor`'s "Metadata extraction skipped" notes. Each module's compile command should carry `-swift-version 6`.

Never measure timing under Xcode's debugger on the watch (see [HANDOFF.md](../HANDOFF.md), Gotchas).

## Artwork and appearance

Each target’s `Assets.xcassets` contains its `AppIcon`, `OverAndOutBrand` wordmark,
and matching light/dark semantic colors. `ASSETCATALOG_COMPILER_APPICON_NAME` is
set for Debug and Release on both app targets. Source artwork and print exports
live in [`../art`](../art); refresh the copies in both targets when artwork changes.

The profile picture picker lists all 18 cases in `OverAndOutKit/Mascot.swift`,
including Pirate. Each case has a matching `Mascot<Name>` imageset under both
targets' `Assets.xcassets/Mascots`. These profile avatars are separate from the
app's primary icon and Talk-screen mascot.

`OverAndOutKit/Brand.swift` provides the shared palette and screen modifier.
Light mode uses ivory and ink; dark mode uses indigo and ivory. Orange is the
Talk/primary-button fill, with ink labels for contrast. Text/link accents use a
darker orange in light mode. Success and destructive actions retain semantic
system colors. The iPhone root reserves a top masthead; the Watch root reserves
a small noninteractive bottom-right wordmark so it does not cover controls.
