# Handoff: Over&Out — the Leave fix (TestFlight build 76) and Beta telemetry (2026-09-28, night)

Read this first. Over&Out: Watch Walkie Talkie replaces Apple's Watch Walkie-Talkie app, which Apple removed in watchOS 27. The watch and iPhone apps work end to end through relay nodes on Google Cloud. **TestFlight build 0.1 (76)** (the Leave fix) is out to the internal group "House" (Steve, Helen, Cooper). **Beta telemetry's server side is live** (2026-09-29, by Steve's OK: the privacy policy, the API and the relay run `a85b15a` from branch `telemetry`; `setup-telemetry.sh` made the metrics, dashboard and alerts). The apps' side is TestFlight builds 79 (telemetry), 81 (usage events) and **0.1 (84)** (build 5, 2026-09-29: the hearing-aid audio fix, unsent events kept on disk, a notifications-off row). Steve's iPhone ran 81 (runs 56–57); 84 is not yet tried. Usage analytics is live too (the spec's "Usage analytics"; `beta.ts usage`, `beta.ts stats`). On production push a locked iPhone plays a message 0.89–1.17 s after the push is sent (runs 53, 55), and a watch tap plays it in 0.67 s (run 51). There are no secrets in this file; tokens and keys live in gitignored files, Secret Manager and `~/.appstoreconnect`, listed under Local config.

## Start here

1. Read this file, the **Over&Out Beta telemetry spec** (Links), then the backlog doc's Beta plan and the feasibility doc's newest Design decisions (two 2026-09-28 rows at the end: the Leave fix and Beta telemetry).
2. **Next:** the next TestFlight build with the two follow-ups from runs 58–61 (backlog, "2 Before the Beta"): the walkie-talkie-off notice worded for the watch too plus a "Walkie-talkie is back on" confirmation, and watch rings while the app is frontmost (run 60: 3.45 s, no prefetch). Then re-measure watch tap → first audio (run 61: 0.88 s, first audio 0.78 s after the audio session; about 0.5 s before) and iPhone push → first audio. Steve's Ring Me On is Apple Watch since run 60; set it back to iPhone for iPhone runs.
3. **Already done:** the Leave fix (build 76), the TestFlight update test (run 56: the channel survives), telemetry and usage analytics (live 2026-09-29; see Done and Deployment today), builds 79, 81 and 84. **TestFlight feedback:** App Store Connect has no email for it; use the App Store Connect iPhone app's notifications, or the webhook (backlog).
4. **Branches:** everything is on `main` (PR #10 merged by Steve on 2026-09-29, with his `SWIFT6_MIGRATION_PLAN.md`). No other open work.
5. Ask Steve before anything outward-facing or billed: Google Cloud resources, deploying the relay, API or website, DNS (he adds GoDaddy records himself), App Store Connect or developer-portal changes Xcode doesn't make itself, TestFlight uploads (say before each), and deletions.

## Links

- **Beta telemetry spec (Claude Docs):** https://claude.ai/code/artifact/bbafed21-49d1-4086-af39-305d378e3463. The design Steve approved on 2026-09-28, updated to what was built.
- **Feasibility doc (Claude Docs):** https://claude.ai/code/artifact/59ab6e47-6e5d-4698-8bd1-173293953df9. Design decisions (date, decision, why, revisit if) and Prototype results (runs 1–55).
- **Backlog (Claude Docs):** https://claude.ai/code/artifact/30273f1c-2795-4fd7-b15a-370b1a177118. Every item has a Beta tier and a triage note saying what needs Steve; the Beta plan section above the table has the agreed order.
- **Repo:** https://github.com/stevetex/WalkieTalkie. `main` = PR #9 (merged by Steve) plus the Leave fix `703c449`.
- **App Store Connect:** app 6816474706, internal group "House" (every build). `node deploy/appstore/asc.ts status` lists groups, testers and builds; `asc.ts feedback`, `crashes [--log <id>]` and `diagnostics [build]` read TestFlight's reports.
- **App name and domain:** "Over&Out: Watch Walkie Talkie", overandout.app (DNS at GoDaddy). Bundle IDs `com.cypressoakstudios.overandout` (iPhone), `…overandout.watchkitapp` (watch) and `…overandout.watchkitapp.notificationservice`. Team `A39XNKNDPX`.

## Next job: test build 76, deploy telemetry, build 3

1. **Build 76 on Steve's iPhone** (TestFlight, production push):
   1. Before opening the updated app, lock the phone and ring it from the bot (`bot.ts send --account`). If it plays, the update kept the PushToTalk channel.
   2. Open the app: walkie-talkie is on, or turns itself back on; Friends offers "Allow Notifications": allow.
   3. Ring, reply from the Lock Screen, tap **Leave**: "Walkie-talkie is off on this iPhone" should appear at once.
   4. Ring again: the watch rings (Ring Me On: iPhone falls back to the watch). That's the first watch ring on a TestFlight build; tap it and time tap → first audio.
   5. Tap the notice (the app opens and rejoins), lock, ring once more: the iPhone plays; re-measure push → first audio.
   Record the runs as 56+ in the feasibility doc and close the backlog row (it's In progress).
2. **Deploy telemetry and build 3** (Start here, step 2). After the deploy, `node server/tools/beta.ts summary --days 1` should show the day's conversations, and the dashboard fills within a day.
3. **Then the rest of the Beta plan:** the monthly node replacement job (a Cloud Scheduler job, ask Steve), rejoin fallbacks on a device, answering mid-message on the watch, and for external TestFlight the review notes, an always-on Test Bot and the invite page's TestFlight link (backlog rows).
4. **Older OS versions:** iOS 16 and watchOS 9 need devices (their simulators don't run on macOS 27).

## Telemetry (built 2026-09-28; server side live 2026-09-29, apps in build 3)

The spec has the design; this is where things are.
- **Server** (`server/src/telemetry.ts`): the relay writes `oao.conversation` (outcome, rings, APNs results, intervals, its events) 2 s after it forgets a conversation (`conversationEnded`, a new relay event), and turns each uploaded device timeline into an `oao.device` summary; timelines are kept in memory for 10 minutes (so `tools/report.ts` and `bot.ts --ring-until-answered` still work) and in Cloud Logging only for `FULL_TIMELINE_USERS`. Also `oao.apns`, `oao.relay_error`, `oao.api` (4xx/5xx with the route template), `oao.registration`, `oao.event` (`POST /v1/events`), `oao.diagnostics`, `oao.feedback`. Nodes write through the Logging API (the container's stdout arrives as plain text); Cloud Run writes JSON to stdout; local runs write `DATA_DIR/telemetry.jsonl`.
- **API:** `POST /v1/events`, `POST /v1/diagnostics` (gzip or raw DEFLATE, up to 900 KB, Firestore `diagnostics`, 30-day TTL), `POST /v1/feedback` (Firestore `feedback`, 90 days, logs `[feedback]`), `diagnosticsRequestedAt` on `GET /v1/me`; account deletion deletes both.
- **Apps:** the kit's `Telemetry`/`DiagnosticsLog` (a rolling JSONL file: 2 MB on the iPhone, 1 MB on the watch, 14 days; "log" lines, which can name friends, stay out). iPhone: MetricKit (`iOS/Diagnostics.swift`), PushToTalk events (`pttJoined`, `pttLeft` with reason, `pttRestored`, `pttRejoin`, `pttJoinFailed`), `registrationFailed`, `relayDropped`, Report a Problem (`iOS/ReportProblemView.swift`). Watch: `Watch/WatchDiagnostics.swift` (unclean-exit marker, the extension's started/finished lines), the pull check and event flush at its idle reload (one extra `GET /v1/me`). Both upload a short timeline on Decline.
- **Usage analytics** (`server/src/stats.ts`, `rollup-main.ts`): `beta.ts usage` (a Firestore snapshot plus activity from the logs) and `beta.ts stats` (the daily `stats/{date}` documents: DAU, WAU, MAU, activity and the snapshot, totals only). `STATS_LOCAL_DIR=<DATA_DIR> node src/rollup-main.ts <date>` runs the rollup locally.
- **Tools:** `node server/tools/beta.ts summary | tester <name> | conversation <id> | pull <name> | logs <name> | feedback | usage | stats` (Cloud Logging and Firestore with Steve's gcloud credentials, or `--local <DATA_DIR>`); `deploy/gcp/telemetry-monitoring.ts print | validate | apply` (the dashboard passed Monitoring's `validateOnly`).
- **Tested:** 103 server tests + 25 on the Firestore emulator; kit 32; in the simulators on a local relay: answered and declined rings, their records and summaries, events, Report a Problem, and pulls from the iPhone and the watch.

## Done on 2026-09-29: telemetry and usage analytics live, runs 56–61, the hearing-aid fix

- **Runs 58–61 (build 84):** the audio fix works on a device (run 59: the hearing aids switched to a call link 105 ms into playback, the engine restarted and the message still played; push sent → first audio 1.31–1.42 s). The Leave notice and rejoin work (run 58; backlog row Done). A Lock Screen reply fails if Talk is pressed while iOS's panel is still appearing (run 58: only "PTT Stop Transmit"); pressed after it settles, Talk → go-ahead 0.97 s over the hearing aids (run 59). **The first watch rings on TestFlight** (runs 60–61): notification 13–17 ms after the push; the extension prefetches on TestFlight (run 61, tap → first audio 0.88 s), but not when the app was left frontmost (run 60, 3.45 s). Reply from the watch: go-ahead 0.31 s.
- **Diagnosing with telemetry worked:** `beta.ts conversation` and `beta.ts logs` (a pull) found each of these without a cable; the iPhone's system log (`sudo log collect`) was needed only for iOS's own Talk panel. `log collect` for the watch failed ("Connection refused (61)").

- **Deployed by Steve's OK:** telemetry, then usage analytics (relay and API `ec72ef6`, website, `setup-telemetry.sh`, `setup-stats.sh`); TestFlight 79, 81 and 84.
- **Run 56 (build 81):** a TestFlight update keeps the PushToTalk channel (iOS relaunches the updated app and restores it). Push sent → first audio 1.72 s: a cold relay after the redeploy (0.94 s to send the push) and slow APNs delivery (0.89 s); the phone's own steps as before.
- **Run 57 (build 81):** static, then "Test Bot is still talking" until End. As PushToTalk activated audio, iOS switched Steve's hearing aids to a call link (`Setting profile … to tsco`); the engine stopped for the configuration change and was restarted with its old connections. **Fix (`1259e9a`, build 84):** `AudioPipeline` rebuilds the engine after a configuration change, and a drain watchdog counts stalled buffers as played; restarts and stalls are `audioRestarted` events. Not yet re-run on the iPhone.
- **Also in 84 (`80b1d0f`):** unsent telemetry events are kept in `pending-events.json` (a background launch's events were lost in run 56); Friends shows "Notifications are off" with Open Settings when notifications are denied (Steve's phone had answered the permission earlier, so the Allow row never showed).
- **TestFlight feedback email:** App Store Connect has none (the earlier "Users and Access → Notifications" advice was wrong). Use the App Store Connect iPhone app's notifications, `asc.ts feedback | crashes`, or a webhook (backlog).

## Done on 2026-09-28 (night): the Leave fix, and telemetry

- **Leave fix (`703c449`, TestFlight build 76, on `main`):** `PushToTalkChannel` keeps `wanted` (defaults `walkieTalkieWanted`) apart from `isJoined`; `turnOff()` for Settings and sign-out; any other leave posts `WalkieTalkieOffNotice` (a local notification) when the app isn't on screen; `rejoinIfWanted()` when the app becomes active. Friends has a "Walkie-talkie is off" row (Turn On) and an "Allow Notifications" row; onboarding explains Leave. Debug-only `OAO_PREVIEW_LEFT_CHANNEL=1` fakes a left channel in the simulator. Not yet tried on the iPhone.
- **Telemetry (`5d5fafd`, branch `telemetry`):** above. The spec is its own Claude Doc; the feasibility doc has a Design decisions row for each.
- **Backlog:** the Leave row is In progress; new rows: ask before sending diagnostics in the App Store build, remove `FirestoreMetricsStore`, watch unclean exits from Xcode, poll TestFlight crashes on a schedule.

## Done on 2026-09-28 (evening): toward the Beta (runs 51–55)

- **Triage:** every backlog item and HANDOFF's MVP list sorted into blocks / before / after the Beta, with sizes and what needs Steve; Steve chose an internal Beta first and kept the iOS 16 / watchOS 9 minimums.
- **Server (`342b8c8`, deployed by Steve's OK):** the shared relay token only reads diagnostics (GET `/v1/users`, `/v1/status`, `/v1/metrics`); relay clients without accounts need `SHARED_TOKEN_CLIENTS=1`, which nodes don't set. The token was rotated (`relay-token` version 2) and the legacy `devices` collection deleted. `pushTokens/{sha256}` names the one registration each push token belongs to, so a device signed into another account or reinstalled can't take rings meant for another; the iPhone's shared `"app:"` token is exempt. `server/tools/reports.ts` lists, shows and resolves reports and deletes accounts. PR #7 (review fixes) was already live (Steve deployed `4835083`).
- **Apps (`6be6f1b`):** privacy manifests (iPhone: UserDefaults CA92.1; watch: UserDefaults and file timestamps C617.1) and `ITSAppUsesNonExemptEncryption = NO` in all three Info.plists (confirmed by Steve).
- **TestFlight (`1dd112d`):** `deploy/appstore/testflight.sh [--notes …]` archives in Release and uploads for internal testing through the App Store Connect API; the build number is the commit count, and it refuses uncommitted `app/` changes. `deploy/appstore/asc.ts` waits for processing, sets What to Test, keeps "House" on every build and adds testers (`add-tester <email>`; internal testers must be App Store Connect users). Build 69 processed in about 3 minutes.
- **Website (`20d7a34`, deployed):** every page has the mascot masthead on indigo, the apps' palette, iPhone-and-watch wording, support@cypressoakstudios.com spelled out and a Cypress Oak Studios LLC footer; the privacy policy covers mascots, favorites, "last messaged you", both devices' push tokens and the watch's prefetched message. `www.overandout.app` redirects to the root (Firebase Hosting; Steve's CNAME to `walkie-talkie-relay.web.app`).
- **Measured:** run 51 watch tap → first audio 0.67 s; run 52 iPhone (sandbox) push → first audio 2.33 s, of which 1.64 s sandbox delivery; run 53 iPhone on production push 1.17 s and a Lock Screen reply; run 55 with Do Not Disturb on 0.89 s (Focus doesn't silence PushToTalk). No double buzz from the prefetch push (run 51).

## Done on 2026-09-28 (later): UI polish (runs 49–50)

On the local branch **`ui-polish`** (`b0e9e18`, committed to deploy, not pushed), plus uncommitted: the deploy scripts' locale fix and this file. Design decisions 2026-09-28 (four rows) in the feasibility doc; backlog updated.
- **Pictures:** a photo or one of the 17 mascots (`art/characters`), Honey by default. `users/{uid}.avatar` (a mascot ID; replaces the photo, and a new photo clears it), `PATCH /v1/me {avatar}`, `avatar` in friend lists. The kit's `Mascot` maps IDs to `Mascot<Name>` images in each app's `Assets.xcassets/Mascots`; `Avatar` draws photo, mascot or the default. iPhone: Settings or onboarding → the picture chooser (`PictureChooser` in `ProfilePhotoPicker.swift`).
- **Ring Me On asks:** the API sets `ringOn` to the device that was ringing when an account's first device of the other kind registers (`registerDevice`); `GET /v1/me` returns `platforms`; the iPhone asks once ("Where should friends ring you?", `askedRingOn-<uid>` in defaults) and its picker shows the server's view.
- **Favorites and "Last messaged you":** `users/{uid}/friends/{id}.favorite` (`PATCH /v1/friends/{id}`), favorites first on the iPhone and the watch's picker; the relay writes `lastMessageAt` on the recipient's entry at talk-start (at most once a minute per conversation, not awaited), shown on the friend page.
- **iPhone:** masthead above the Friends title (no navigation bar on Friends); Talk screen title is the friend's picture and name, End Conversation under the status; branded ring (bell mouth, Decline then orange Answer); three-step onboarding with art (watch step only when paired); Settings → Appearance (System/Light/Dark, `@AppStorage("appearance")`); ivory screens get a visible bar background so the status bar follows the appearance (`brandScreen()`); the Talk mascot upscaled 2× with MetalFX (`art/upscale-art.swift`, `art/masters/mascot-talk-2x.png`).
- **Watch:** dark palette only (its colour assets have no light variant), friend pictures on the main screen, ring layout, diagnostics only in debug builds, "moved" ends the screen ("Continued on your iPhone"). `MascotTalkButton` and `MascotGeometry` are in the kit.
- **Tools:** `node tools/test-account.ts photo [file.jpg]` (default `tools/test-bot-photo.jpg`, the 🤖 on indigo; the live bot has it).
- **Measured:** watch tap → first audio 0.56 s (run 49); iPhone push sent → first audio 1.02 s over Bluetooth (run 50).
- **Next:** Steve reviews and asks for a push and PR of `ui-polish`; then the MVP list below.

## Done on 2026-09-28: walkie-talkie on the iPhone (runs 44–48)

- **Design** (feasibility doc, 2026-09-27 rows): PushToTalk on devices, one "Over&Out" channel whose descriptor names the current friend; an in-app ring over the open relay stream when PushToTalk isn't available (the simulator, or the channel was left); no alert ring on the iPhone. A friend's message plays at once on the iPhone (being in the channel = available). One device rings, never both: `ringOn` on the account ("watch", "iphone", unset = the watch if there is one), the other device if the chosen one can't be reached, otherwise "isn't available" at once; the device used last keeps the conversation. The iPhone has its own `TalkController`; the watch's code is unchanged.
- **Relay** (`server/src/relay.ts`, `main.ts`, `apns.ts`): connections per device (the session token's `dev`), `moved` when a conversation moves to another of the user's devices, ring target selection (`ringTargets`), PushToTalk pushes (`pushToTalkRing`: topic `<iPhone bundle>.voip-ptt`, expiration 0, **an `aps` dictionary**), in-app rings for `app:` registrations, `talk-refused` reason `unavailable`, and one retry on a fresh APNs connection after a transport error. **API:** `PATCH /v1/me {ringOn}`, `PUT /v1/me/device {pushType: "pushtotalk"}`; `ringLookup` reads `ringOn` in the same batch.
- **iPhone** (`app/iOS`): `PushToTalkChannel.swift` (the channel manager, token kept in defaults), `TalkController.swift` (PushToTalk or the app's own audio session; timelines with `pttPushReceived` and the audio route), `TalkView.swift` (the mascot's mouth is hold-to-talk; the in-app ring screen), Settings → Walkie-Talkie (the channel on/off, Ring Me On, and on debug builds the PushToTalk state), an onboarding step, `AppDelegate` making `AppModel.shared` at launch. `Config/iOS.entitlements` (push and Push to Talk; `iOS-NoPush.entitlements` for `OAO_PUSH=no`), `UIBackgroundModes` `push-to-talk` **and `audio`**. The kit's `AudioPipeline.start(capture:)` starts the speaker alone for PushToTalk receiving.
- **Found on Steve's iPhone** (design decision 2026-09-28, runs 45–46): pushes without `aps` never reach the app; the app needs the audio background mode or `audiomxd` refuses its audio; the channel manager must be made in `didFinishLaunching`; iOS doesn't resend the channel token after leaving and rejoining; starting the microphone while receiving makes the engine restart and drop the audio; the APNs sandbox connection can be dead without the phone noticing.
- **Measured:** iPhone push sent → first audio 1.16 s (run 45) and 1.54 s over Bluetooth HFP (run 47); Lock Screen Talk → first frame 1.14 s; watch tap → first audio 0.76 s after the relay changes (run 48). Simulators: iPhone → watch, watch → iPhone and iPhone ↔ iPhone (run 44).

## Done on 2026-09-27 (runs 36–43)

- **Device tests:** sign-in and the watch over WatchConnectivity (run 36); the invite link and acceptance sheet (37); report and block, with the alert email and the refused ring (38); account deletion with Apple token revocation and the watch signing out (39); a new account and a ring (40). Steve is now `u_lddgnN9Qtcspo663`.
- **iPhone fixes and UX:** the masthead sits inside the navigation stack (it hid the Settings button); deletion is its own screen that explains Apple's "Sign in to Over&Out" confirmation and ends on "Your account is deleted"; "Your name" is "Screen name"; Settings → About Over&Out (`app/iOS/AboutView.swift`: logo, "Watch Walkie Talkie", "for iPhone and Apple Watch", version, support@cypressoakstudios.com, links, a greyed-out Rate placeholder, © 2026 Cypress Oak Studios LLC, Apple's trademark line); `Brand.artIndigo` matches the wordmark art's background.
- **Watch main screen** (runs 41–42): the mascot on indigo, its mouth is hold-to-talk (only the mouth and ring respond; the mouth shows idle, talking with the antenna ball lit, connecting, and the friend talking), the friend's name and End top left, Settings top right, an in-app ring that wiggles the mascot with Answer and Decline below it. Geometry in `MascotGeometry` (`Watch/ContentView.swift`), art `OverAndOutMascot` in the watch's assets. "Is talking" lasts until the speaker has played everything (`AudioPipeline.onPlaybackDrained`).
- **Profile photos** (run 43, API `3880fac`): each person picks one in Settings or onboarding; a 256 px JPEG in Firestore `photos/{uid}`, `photoVersion` on the user and in friend lists, `PUT`/`DELETE /v1/me/photo`, `GET /v1/users/{id}/photo` for the owner and friends only; `Avatar` and `PhotoCache` in the kit; the watch shows photos in its friend picker and on an in-app ring, downloaded after its idle friends reload. Report has an "Inappropriate profile photo" reason. The privacy policy covers photos. The Test Bot has a photo.
- **Tools:** `node tools/test-account.ts invite` makes an invite from the bot. `OAO_BOT_TOKEN_FILE=<file>` keeps a local bot apart from the Google Cloud one (`OAO_API=http://localhost:8080 node tools/test-account.ts create`, then `invite`, and `bot.ts send --account` with the same variable). A watch simulator left with a deleted account's session needs `xcrun simctl keychain <watch> reset`.

**Still to do for the MVP:** the App Store listing (screenshots, description, privacy label: identifiers, name, usage data, and User Content → Photos or Videos for profile photos, linked to the user, app functionality; the privacy policy is at overandout.app/privacy, support at /support), the website in the new branding (`web/public`), retiring the shared relay token (backlog), and the watchOS 9–11 checks (backlog).

## Where things stand

- **Accounts (2026-09-27):**
  - **API** (`server/src/api.ts`, `accounts.ts`, `session.ts`, `apple.ts`; `api-main.ts` for Cloud Run): Sign in with Apple with a nonce; Ed25519 JWT session tokens (30 days, refreshed when a day old, refreshable up to a year past expiry while the session exists); the iPhone mints the watch's session (`POST /v1/auth/device`); profile, friends, single-use 7-day invites, blocks, reports (logged as `[report]`, emailed by an alert), push registration (`PUT /v1/me/device`), account deletion with Apple token revocation.
  - **Firestore model:** `users/{uid}` (with `photoVersion`) with `friends`, `blocks`, `devices` and `sessions` subcollections; `appleSubs/{sub}`; `invites/{code}` (TTL on `expireAt`); `reports/{id}`; `photos/{uid}`. The account logic runs on a small `Docs` interface: Firestore REST with atomic commits and preconditions, or `MemoryDocs` locally.
  - **Relay:** accepts session tokens (user and device from the token); the shared token only reads diagnostics (since `342b8c8`). An account can only ring a friend (`ringLookup`, one Firestore batch read per ring); one kind of device rings (see Done on 2026-09-28); otherwise `talk-refused`. Diagnostics are shared-token only; `POST /v1/devices` only works on a relay with `SHARED_TOKEN_CLIENTS=1`.
  - **Tests:** `npm test` runs 119 (94 pass, 25 skip without the emulator); `npm run test:firestore` runs 25 against the Firestore emulator. The kit's tests: 24 (`swift test`, or `xcodebuild test -scheme OverAndOutKit` on a simulator).
- **iPhone app (`app/iOS`):** sign-in, onboarding (screen name and optional photo, Focus step, watch), friends list with photos, invite via the share sheet, invite acceptance sheet (universal links), friend page (report with reasons and optional block, block, remove), settings (photo, screen name, watch status and re-send sign-in, Focus help, blocked people, privacy and support links, About Over&Out, sign out, the Delete Account screen), and now talking: a Talk screen per friend, PushToTalk, Settings → Walkie-Talkie.
- **Branding (2026-09-27, `0e65ca9`):** the icon ("Chrome Tomorrow" mascot), the stacked wordmark and light/dark semantic colors are in each target's `Assets.xcassets`; `OverAndOutKit/Brand.swift` has the palette and `.brandScreen()`. The iPhone's Friends and sign-in screens have a masthead; the watch's main screen is the mascot (above). Source art, exports and usage notes are in `art/` (see `art/README.md`). The website (`web/public`) doesn't use it yet.
- **Watch app:** its session comes from the iPhone (`Watch/WatchAccount.swift`), stored in the Keychain under the app group; friends from the API, cached, with a picker when there's more than one; push token registered under the account; token refresh and friends reload 5 s after coming to the front and only when idle (never on the ring path). The shared token is gone from the builds.
- **Prefetch prototype** (2026-09-27): the relay sends a second, silent push 3 s after an APNs ring; the notification service extension downloads the held message (now with the account's token from the Keychain) and the app plays it on the tap. Tap → first audio 0.60–0.77 s (runs 32–34), 0.48 s with accounts (run 36). Refinements are in the backlog.
- **Relay (`server/`):** Node 24+, TypeScript run directly, no dependencies. Stores are async interfaces: JSON locally, Firestore (REST) on nodes. Reads its secrets from Secret Manager, drains for up to 45 s on SIGTERM, reports its revision in `/healthz`. `SIMULATOR_PUSH=1` delivers rings to simulators.
- **Infrastructure:** option E steps 1–3 (relay nodes), plus the Cloud Run API and Firebase Hosting. Setup and runbook: [deploy/gcp/README.md](deploy/gcp/README.md).

### Measured on Steve's watch (no debugger, real APNs)

| What | Result |
| --- | --- |
| Push sent → notification on the watch | 0.01–0.3 s |
| Tap on notification → first audio | **0.48 s** with accounts (run 36); 0.60–0.77 s with the prefetch prototype (runs 32–34); 2.4–3.7 s without it (runs 28–30) |
| Answer in the app → first audio, with pre-connect | 0.95–1.50 s (runs 22, 25, 35) |
| Wrist down and quiet spells | Plays with the wrist down and survives 35 s of silence with **no** background modes (run 21) |
| Do Not Disturb | Rings break through only if Over&Out is on the Focus's allowed apps. Onboarding now guides users to that |
| Talk → relay's "go ahead" | 0.2–0.48 s |

### Measured on Steve's iPhone (no debugger, PushToTalk; runs 45–52 sandbox APNs, 53–55 production)

| What | Result |
| --- | --- |
| Push sent → PushToTalk push received | 0.28–0.32 s on production (runs 53, 55); 0.17–1.64 s on the sandbox |
| Push received → audio session active | 0.46–0.65 s |
| Push received → relay stream joined | 0.97–1.18 s (the cold connection is the longest step) |
| **Push sent → first audio (no tap)** | **0.89–1.17 s** on production over Bluetooth (runs 53, 55); 1.02–1.54 s on the sandbox |
| Lock Screen Talk → first frame sent / relay's go-ahead | 1.14 s / 1.28 s (run 47) |

## Open risks

- **WatchConnectivity handoff** worked once on hardware (run 36). If it proves unreliable, the fallbacks are the watch asking again on reachability changes (already there), Settings → "Sign In on Watch Again" on the iPhone, or Sign in with Apple on the watch.
- **App Review:** report/block and account deletion are in; the listing, privacy label and review notes aren't written yet.
- **iOS 16 and watchOS 9–10 are untested on devices.** Their simulators: iOS 16 and watchOS 9 don't run on macOS 27; iOS 17.0 and watchOS 10.2 launch the apps and encode Opus. The extension and background behaviour need a device.
- **The system's Leave button** turned the iPhone's walkie-talkie off without telling the person (run 54). Fixed in build 76 (a notice, a Friends row, rejoin on open), not yet tried on a device.
- **Telemetry isn't deployed yet,** so testers beyond Steve would still be invisible: deploy it before adding testers.
- **App Review and the audio background mode:** the iPhone declares `audio` alongside `push-to-talk` because PushToTalk can't activate its audio in the background without it. It's ordinary playback (guideline 2.5.4); explain it in the review notes.
- **One relay node:** a deploy or a node failure means about 2 minutes without the relay until option E's failover and a second node exist.

## Deployment today (Google Cloud)

- **Resources** (project `walkie-talkie-relay`, owned by stevelt@gmail.com; all in us-central1):
  - instance group `relay` (zone us-central1-a) with one node, `relay-1` (e2-micro, COS, 10 GB boot disk, 10 GB data disk `relay-1-1`), template `relay-<commit>`, **running `ec72ef6`** (telemetry and usage analytics, deployed 2026-09-29);
  - static IP `walkie-relay-ip` `35.209.96.216` (Standard tier), on `relay-1`;
  - Firestore (default) database, TTL policies on `timelines.expireAt` and `invites.expireAt`;
  - service accounts `relay-node` (Firestore, logs, metrics, image pull, its secrets) and `account-api` (Firestore, the API's secrets);
  - Cloud Run service `api` (`https://api-yqgprbu3ja-uc.a.run.app`, scales to zero, max 4 instances, running `ec72ef6`);
  - Firebase added to the project (Steve accepted the terms in the console); Hosting site `walkie-talkie-relay` (`walkie-talkie-relay.web.app`) with the custom domains overandout.app and www.overandout.app (a redirect to the root); `/v1/*` rewritten to `api`;
  - Artifact Registry repo `relay` (images `relay` and `api`); Secret Manager secrets `relay-token` (version 2 since 2026-09-28; Steve destroyed version 1, the leaked value), `apns-key`, `acme-eab`, `session-signing-key`, `session-public-keys` (key ID `k20260927`) and `apple-siwa-key`;
  - health check `relay-health`, firewall rule `walkie-web` (80/443), two uptime checks and alert policies, and the alert policy "Over&Out: user report";
  - **telemetry (2026-09-29):** log `oao-telemetry` (the relay's entries; the API's are in its Cloud Run stdout), 11 log-based metrics `oao_*`, the dashboard "Over&Out Beta" (https://console.cloud.google.com/monitoring/dashboards/builder/8c95ff4a-8e0e-46cc-9855-3242ae13fe62?project=walkie-talkie-relay), alert policies "Over&Out: rings failing", "APNs setup", "API errors", "app crashed", "dropped conversations", "problem report", and TTL policies on `diagnostics.expireAt` and `feedback.expireAt`. The relay and the API run `ec72ef6` (2026-09-29). **Usage analytics (2026-09-29):** metrics `oao_actions` and `oao_daily`; Cloud Run job `stats` (the API image, `node src/rollup-main.ts`, as `account-api`, which now also has `roles/logging.viewer`; `deploy-api.sh` keeps its image current); Cloud Scheduler job `stats-daily` (us-central1, 00:30 UTC; Cloud Scheduler enabled); Firestore `stats/{date}`.
- **DNS** at GoDaddy: `relay-1.overandout.app` and `walkie.cypressoakstudios.com` A → `35.209.96.216`; `overandout.app` A → `199.36.158.100` and TXT `hosting-site=walkie-talkie-relay` (Firebase Hosting; the parked A record was replaced on 2026-09-27); `www` is a CNAME to `walkie-talkie-relay.web.app` (a Firebase redirect to the root).
- **Deploy:** commit, then `deploy/gcp/deploy-relay.sh` (about 2 minutes of downtime with one node), `deploy/gcp/deploy-api.sh` and `deploy/gcp/deploy-web.sh`. `gcloud` is at `~/google-cloud-sdk/bin`, which isn't on the agent shell's PATH, so prefix `export PATH=$HOME/google-cloud-sdk/bin:$PATH`.
- **Logs:**

  ```bash
  gcloud compute ssh relay-1 --zone=us-central1-a --project=walkie-talkie-relay -- sudo journalctl -u relay -n 100
  ```

  ```bash
  gcloud logging read 'resource.labels.service_name="api"' --project=walkie-talkie-relay --limit=50
  ```

  After a node is replaced, SSH refuses its new host key; see the deploy README's Everyday commands.
- **Data:** accounts in Firestore: Steve (`u_lddgnN9Qtcspo663` since 2026-09-27 run 40; the earlier `u_gNuPMeGUZQe1GC5A` was deleted in run 39) and the Test Bot (`u_NvlyGM47nb3JKca_`, Apple ID stand-in `test-bot.overandout`), who are friends. The legacy `devices` collection was deleted on 2026-09-28. `pushTokens/{sha256}` documents name each push token's registration. Local simulator accounts live in the local relay's `DATA_DIR`, not Firestore.
- **Project list lag:** the project may not show in `gcloud projects list`, but it works by ID.

## Local config (gitignored; don't commit or print)

- `deploy/gcp/config.sh`: `PROJECT_ID`, `DOMAIN` (the relay's hostname; the web tool uses `WEB_DOMAIN`), the relay's diagnostics token `SPIKE_TOKEN` (rotated 2026-09-28), the `APNS_*` settings, `ALERT_EMAIL`, `SUPPORT_EMAIL` (support@cypressoakstudios.com, on the site's pages), and the Sign in with Apple key: `APPLE_SIWA_KEY_FILE` (`AuthKey_2SAVY539QZ.p8` in the repo root), `APPLE_SIWA_KEY_ID` and `APPLE_TEAM_ID`.
- **Secret Manager** holds the node and API copies (above). To rotate one, add a new version (`gcloud secrets versions add … --data-file=-`) and redeploy. The old relay token was printed in session transcripts on 2026-09-26 and 2026-09-28; it's rotated, and it gets 401.
- `deploy/appstore/config.sh`: `ASC_KEY_ID` (`77DKLP5RCG`, an Admin team key), `ASC_ISSUER_ID`, `ASC_GROUP` ("House"). The key itself is `~/.appstoreconnect/private_keys/AuthKey_77DKLP5RCG.p8` (mode 600), where Apple's tools look. The repo root's `AuthKey_2SAVY539QZ.p8` is the Sign in with Apple key and `AuthKey_KDWRDCFK7K.p8` the APNs key (both gitignored).
- `deploy/gcp/config.sh` also has `FULL_TIMELINE_USERS` (Steve's and the Test Bot's account IDs), which `deploy-relay.sh` passes to the relay.
- `server/data/bot-token.json`: the Test Bot's session token (created by `tools/test-account.ts`, mode 600). `server/data/` is gitignored.
- `app/Config/Local.xcconfig`: the paid `DEVELOPMENT_TEAM`. Its `OAO_SERVER_TOKEN` is no longer used by builds.
- `watch/Config/Local.xcconfig`: the spike's settings (Personal Team). The spike is kept for reference only.
- To use the shared token in commands without printing it:

  ```bash
  grep -o 'SPIKE_TOKEN="[^"]*"' deploy/gcp/config.sh | cut -d'"' -f2
  ```

## Testing on the watch

- **Hardware:** Steve's watch, on watchOS 27 (UDID `00008320-0013043A1E60000A`), paired with an iPhone. Over&Out is on the allowed apps of Steve's Do Not Disturb Focus.
- **Install:** Steve runs the **OverAndOut** scheme (iPhone plus the embedded watch app) or **OverAndOutWatch** from Xcode, then clicks **Stop**, so there's no debugger during measurements.
- **Ring it with the bot** as its account, from `server/`:

  ```bash
  SPIKE_SERVER=https://relay-1.overandout.app SPIKE_TOKEN=… node tools/bot.ts send --account --say "…" --ring-until-answered --stay 30
  ```

  `--account` rings the bot's first friend; `SPIKE_TOKEN` is only needed for `--ring-until-answered` (it reads timelines). `--again N` sends a second message N s after the watch joins. Without `--account`, the old shared-token mode still works for old builds (`--to watch-0d34`).
- **Timeline:** `node tools/report.ts <conversationId>` (with `SPIKE_TOKEN`). The watch uploads its timeline when the conversation ends, so ask Steve to tap **End**.
- **Cold start:** Settings → Testing → **Quit when I leave** (debug builds), then press the crown. watchOS 27 has no app switcher, and quitting in the foreground brings the app back.

## Testing on the iPhone

- **Hardware:** Steve's iPhone 17 Pro Max ("Tex iPhone 17", UDID `00008150-000215EA3E02401C`), iOS 27. It runs **TestFlight build 69** now (production push); an Xcode install (the **OverAndOut** scheme, then **Stop**) replaces it with a sandbox build. After a reinstall, check Settings → Walkie-Talkie: it can leave the channel (backlog), and then rings go to the watch.
- **Ring it with the bot:** set Ring Me On to iPhone, lock the phone, then `bot.ts send --account` as above. The message plays with no tap; `--stay 60` leaves time to reply from the Lock Screen's Talk button (tap the blue waveform in the Dynamic Island). The iPhone uploads its timeline when it leaves the conversation, which it does by itself once the audio stops.
- **If a ring goes to the watch** with Ring Me On: iPhone, the iPhone left its channel: check Settings → Walkie-Talkie, and the phone's log for "Left the channel, reason N" (1 = the person, for example the system's Leave button).
- **If nothing plays** on a sandbox (Xcode) build and the timeline has no `pttPushReceived`, toggle Airplane Mode on the iPhone (see Gotchas), then ring again.
- **The phone's own log** (the app logs to subsystem `com.cypressoakstudios.overandout`, PushToTalk to `com.apple.pushtotalk.framework`, the system side is `callservicesd`, pushes are `apsd`): connect the iPhone by cable, then Steve runs in a terminal tab (it needs his password)

  ```bash
  sudo log collect --device-udid 00008150-000215EA3E02401C --last 5m --output <scratchpad>/iphone.logarchive && sudo chown -R $USER <scratchpad>/iphone.logarchive
  ```

  and read it with `/usr/bin/log show <archive> --info --debug --style compact --predicate 'subsystem == "com.cypressoakstudios.overandout"'` (zsh has its own `log` builtin, so use the full path).

## Simulator

A local relay that also serves the API, accepts dev sign-ins and delivers rings to simulators:

```bash
cd server && PORT=8080 DATA_DIR=<dir> SPIKE_TOKEN=simtoken SERVE_API=1 DEV_APPLE_SIGNIN=1 SIMULATOR_PUSH=1 node src/main.ts
```

```bash
cd app && xcodebuild -project OverAndOut.xcodeproj -scheme OverAndOut -destination 'id=8C493A02-0688-4BC3-960F-95D94F320025' -derivedDataPath <dir> DEVELOPMENT_TEAM= OAO_PUSH=no OAO_BUNDLE_ID=com.cypressoakstudios.overandout.dev OAO_SERVER_HOST=localhost:8080 OAO_API_HOST=localhost:8080 build
```

Then:
1. Install `OverAndOut.app` on the iPhone 18 Pro Max simulator (`8C493A02-…`) and `OverAndOutWatch.app` on its paired Apple Watch Series 12 (46mm) (`5DE92663-5226-41E6-9799-2C68705F50F7`) with `xcrun simctl install`.
2. On the iPhone, sign in with the "Test user" field (debug builds against a local API), for example "Steve".
3. Launch the watch app as the same dev user: `SIMCTL_CHILD_OAO_DEV_USER=steve xcrun simctl launch 5DE92663-5226-41E6-9799-2C68705F50F7 com.cypressoakstudios.overandout.dev.watchkitapp`.
4. `OAO_API=http://localhost:8080 node tools/test-account.ts create` makes a local bot; befriend it with an invite, then `SPIKE_SERVER=http://localhost:8080 node tools/bot.ts send --account` (or `listen --account`).

Details:
- Telemetry locally: the relay writes `DATA_DIR/telemetry.jsonl`; read it with `node tools/beta.ts summary --local <DATA_DIR>` (and `tester`, `logs`, `feedback`, `pull`). `OAO_BOT_TOKEN_FILE=<file>` keeps a local bot; befriend it by signing in as `dev:<name>` with curl for an invite (the 2026-09-28 session did this on port 8091).
- The simulator has no PushToTalk; `SIMCTL_CHILD_OAO_PREVIEW_LEFT_CHANNEL=1` fakes a left channel so Friends shows "Walkie-talkie is off".
- The watch simulator has no microphone, so it sends a 440 Hz test tone.
- The Claude Code iOS Simulator tool: taps on the iPhone simulator register more reliably with `duration: 0.1`; on the watch use a short `touch_path`. The iPhone 18 Pro Max is 440×956 points (screenshots are about 2.09× that).
- The server hosts are read from the build on every launch.

## Gotchas

- **Never measure timing under Xcode's debugger.** Over the watch's wireless link it stops the whole app for 1–20 s whenever a system library loads.
- **WatchConnectivity doesn't work in the Xcode 27 simulators here:** the iPhone simulator's `wcd` logs "XPC has informed us that a fatal error has occured" from IDS, and the app's `WCSession` never finishes activating, even after rebooting the pair. Hence the watch's dev sign-in. Test the handoff on devices.
- **Xcode can't always reach the watch** (`CoreDeviceError 4000`). Wake and unlock the watch and the iPhone, and put them on the same Wi-Fi as the Mac. Don't run `devicectl` while Steve is using Xcode.
- **Node strips TypeScript types but doesn't transform them:** constructor parameter properties (`constructor(private x)`) fail at runtime. Use plain fields.
- **Simulator builds need their ad-hoc signature** (don't pass `CODE_SIGNING_ALLOWED=NO`). For device compile checks, it's fine.
- **No `timeout` on macOS:** use `perl -e 'alarm N; exec @ARGV'`.
- **Stage files by name,** never `git add -A`.
- **COS's host firewall drops incoming TCP except SSH.** The node's cloud-init opens 80 and 443; without that, health checks fail and autohealing recreates the node every 5 minutes.
- **A newly enabled Google API can refuse calls for a minute or two.** But Firebase's `addFirebase` kept refusing (PERMISSION_DENIED) until Steve added Firebase in its console, which is where its terms are accepted.
- **Service account IDs need 6–30 characters** (hence `account-api`).
- **Cloud Run reserves some paths ending in "z"**, so the API also answers `/v1/health`.
- **The Firestore emulator needs Java 21+.** `brew install openjdk` (keg-only) is installed, and `npm run test:firestore` uses it.
- **Don't print a built app's Info.plist** (old builds carry the relay token as `OAOServerToken`), or `server/data/bot-token.json`. Print only the keys you need.
- **The watch simulator never runs the notification service extension** for `simctl push`, and taps on its buttons often don't register (a short `touch_path` works better). Test the extension on Steve's watch.
- **A replaced node's SSH host key changes.** Remove the old entry with `ssh-keygen -R compute.<instance id> -f ~/.ssh/google_compute_known_hosts`; gcloud then reads the new key from guest attributes.
- **`zsh` doesn't split unquoted variables,** so `gcloud … $FLAGS` passes one argument. Spell flags out, or run the command under `bash`.
- **The share sheet's Copy puts a URL on the pasteboard,** which `xcrun simctl pbpaste` doesn't print.
- **PushToTalk doesn't run in the simulator** (`PTChannelManager` fails with InvalidPlatform), so simulator iPhones talk only in the app, with rings over the open relay stream.
- **The APNs sandbox connection can be dead without the iPhone noticing.** PushToTalk pushes are then accepted (HTTP 200) and never delivered, and the phone's `apsd` logs nothing. Toggling Airplane Mode fixes it until next time. Apple DTS (developer forums thread 773514) advises testing PushToTalk with production push.
- **PushToTalk pushes need an `aps` dictionary** in the body, despite Apple's example (forums thread 772008), and the app needs the `audio` background mode as well as `push-to-talk`, or the system won't activate its audio in the background.
- **An iPhone test build's relay is `relay-1`,** but a local relay for the simulators may already hold port 8080 (another session's); run yours on another port and build with `OAO_SERVER_HOST` and `OAO_API_HOST` set to it.
- **Deploy scripts under a non-UTF-8 locale:** macOS's bash 3.2 read the "…" after `$template` as part of the variable name ("template…: unbound variable"). Variables next to non-ASCII text are now braced (`${template}…`).
- **Simulator taps:** the first tap after typing or navigation often doesn't register; repeat it, or wait a second.
- **Stale device registrations win rings:** a simulator watch signed in under an earlier account stayed registered there and took the ring meant for that account's iPhone (backlog).

- **The system's Leave button** (beside Talk on the iPhone's Lock Screen and Dynamic Island) leaves the PushToTalk channel: InCallService logs "PTT Leave Button Tapped" and the app gets reason 1. Don't tap it to end a conversation during tests; it ends by itself a few seconds after the audio stops.
- **Old simulator runtimes:** iOS 16 and watchOS 9 runtimes don't run on macOS 27 ("not supported on hosts after macOS 26.99.99"). Xcode 27's command line won't fetch older runtimes; Steve downloads them from developer.apple.com and `xcrun simctl runtime add <dmg>` imports them. The simulator tool's taps don't reach iOS 17 or watchOS 10 simulators. Created: "iPhone 15 Pro (iOS 17)" and "Apple Watch Series 9 (watchOS 10)", paired.
- **The kit's account tests fail on watchOS 10.2** because their URLProtocol stub isn't used there; run `-only-testing:OverAndOutKitTests/VoiceCodecTests` on old watch runtimes.
- **`deploy-web.sh` sources `config.sh`,** whose `DOMAIN` is the relay's hostname; the Hosting tool reads `WEB_DOMAIN` (`REDIRECT_TO` for a redirect domain). The Firebase Hosting REST API needs `x-goog-user-project: walkie-talkie-relay` with user credentials.
- **The permission checker blocks Secret Manager writes and destroys** in some forms; give Steve the command instead.

- **The iPhone simulator kills Over&Out as soon as it leaves the screen** (Home or Lock; SIGKILL from runningboard, `main` too), so anything that should happen in the background (the walkie-talkie-off notice) can only be checked on a device.
- **Simulator typing right after navigation can arrive late,** into the field once it has focus; screenshot before sending a form.
- **A metric-threshold alert needs `resource.type` in its filter:** `global` for the relay's entries, `cloud_run_revision` for the API's.
- **Cloud Monitoring's percentile reducers are 5, 50, 95 and 99** (no p90), so the dashboard and `beta.ts` show p50 and p95.
- **The relay container's stdout reaches Cloud Logging as text** (`jsonPayload.message` in `cos_containers`), so the relay writes structured entries with the Logging API instead.
- **App Store Connect answers 404** for a build's `diagnosticSignatures` until Apple has any; `asc.ts diagnostics` says "none yet".

## Steve's preferences

- **Hosting:** Google Cloud only, among AWS, Azure and Google Cloud. No Cloudflare or other new providers. No manual VM or OS patching.
- **Git:** commit or push only when asked. Committing locally in order to deploy is fine.
- **Doc:** record design decisions and measured results in the feasibility doc; small non-blocking follow-ups go in the backlog doc.
- **Secrets:** never print the relay token, APNs keys, signing keys or a built app's Info.plist.
- **DNS:** Steve adds GoDaddy records himself; give him the exact records.
