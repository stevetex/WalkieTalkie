# Handoff: Walkie-Talkie for Apple Watch — from spike to product (2026-09-24)

Read this first. The spike is finished: it proved on a real Apple Watch that the design works. The next session starts building the real app, once Steve's paid Apple Developer Program membership is active. There are no secrets in this file. Tokens and keys live in gitignored files, listed under Local config.

## Start here

1. Read this file, then the feasibility doc (link below), especially Design decisions, Prototype results and Recommended plan.
2. Confirm with Steve that the membership is active, and get his paid **Team ID**. (On 2026-09-25 it was still pending.)
3. Work through "First steps with the membership", in order. Push is the one thing the spike couldn't test.
4. The product decisions were agreed on 2026-09-25 (see "Decisions made"). The product project is in `app/` (see [app/README.md](app/README.md)).

## Goal

A third-party replacement for Apple's Watch Walkie-Talkie app, which Apple removed in watchOS 27. It should be push-to-talk between friends, ringing the watch, answered with a tap, then a hold-to-talk conversation.

- **Feasibility doc (Claude Docs):** https://claude.ai/code/artifact/59ab6e47-6e5d-4698-8bd1-173293953df9. Log design decisions in its "Design decisions" table (date, decision, why, revisit if), and add measured results to Prototype results.
- **Repo:** https://github.com/stevetex/WalkieTalkie. `main` is pushed and clean (the last spike commit is the one that added this handoff).

## The design to build: option C (decided 2026-09-23)

Steve rejected option B (ring through CallKit, then end the call on answer) as too kludgey for a commercial app. Option C is the design:

1. **Ring:** the relay sends a **time-sensitive alert push** through APNs, with the conversation ID in the payload. No CallKit and no VoIP push on the watch.
2. **Answer:** tapping the notification opens the app, and the tap counts as the answer.
3. **Connect:** the app opens the relay stream with `GET /v1/relay/stream?join=<conversationId>`, which joins and starts the replay of the buffered message in the same request.
4. **Talk:** the app runs its own `AVAudioSession` (playAndRecord, voiceChat). Audio is Opus at 24 kbps in 20 ms frames, over plain HTTPS: a long-lived streamed response down, back-to-back POSTs up. WebSockets aren't allowed on the watch outside a call (TN3135).
5. **Conversation window:** after the answer, both sides talk freely until 45 s pass with no audio.

**Relay behavior (already built, in `server/src/relay.ts`):**
- It buffers the sender's burst and replays it when the recipient joins.
- It abandons a ring after 35 s, drops the unheard audio and tells the sender `ring-timeout`.
- It handles floor control (one talker at a time).

### What the spike measured on the watch (option C path, no debugger)

| What | Result |
| --- | --- |
| Tap on notification → first audio | **about 2.5–2.9 s** (runs 11–14), down from 4.7–5.2 s |
| Answer → own audio session on | 60–300 ms |
| Talk pressed → microphone's first frame | 24–90 ms |
| Talk pressed → relay's "go ahead" | 0.27–0.96 s (0.4 s typical) |
| Incoming audio with the wrist down | **Plays** (run 9). The app keeps running in the background while its audio session is active, and is suspended once the conversation ends |
| Cold start | watchOS launches the app in the background when the notification is delivered, then suspends it until the tap, so launch time doesn't add to the delay |

**Where the remaining ~2.5 s goes:** the first request the watch sends after waking takes 1.7–1.9 s to reach the relay, even over an already-open HTTP/2 connection (runs 11, 13, 14).

**Idea to cut it to about 1 s (untested):** send the queued message down a stream opened before the tap, so the watch sends nothing after the tap. This only helps when the app was launched for the notification, and it means the audio reaches the watch before the user answers (it's still only played on the tap). There's more in the Prototype results table (runs 1–14) in the doc.

## First steps with the membership

1. **Signing:** in `app/Config/Local.xcconfig`, set `DEVELOPMENT_TEAM` to the paid Team ID, and remove the Personal Team overrides (`OAO_BUNDLE_ID = ….dev` and `OAO_PUSH = no`). The bundle IDs are `com.cypressoakstudios.overandout` and `com.cypressoakstudios.overandout.watchkitapp`.
2. **Capabilities** on the watch app's App ID (developer portal, or Xcode's Signing & Capabilities): **Push Notifications** and **Time Sensitive Notifications**. `app/Config/Watch.entitlements` already asks for both. The spike's Personal Team couldn't have either, so its test notifications were delivered as ordinary ones.
3. **APNs key:** create an APNs auth key (.p8) in the portal. Put its path, Key ID and Team ID in `deploy/gcp/config.sh` (`APNS_KEY_FILE`, `APNS_KEY_ID`, `APNS_TEAM_ID`), and set `APNS_BUNDLE_ID` to the **watch app's** ID, `com.cypressoakstudios.overandout.watchkitapp`: the watch registers for pushes itself, so that's the topic. Then run `deploy/gcp/deploy.sh`, which copies the key to the VM. The server reads `APNS_KEY_PATH` etc. (`server/src/main.ts`).
4. **Server, alert push: done** (`f5aa971`, not deployed yet). `Relay.ring()` sends a time-sensitive alert push (`ringAlert()` in `server/src/apns.ts`) to the `APNS_BUNDLE_ID` topic. It expires when the relay abandons the ring (35 s) and collapses on the conversation ID. Tokens are `pushToken` now; `voipToken` is still accepted.
5. **Watch, remote notifications (in the new app):** register with `WKApplication.shared().registerForRemoteNotifications()`, and send the device token to `POST /v1/devices` as `pushToken`. On the notification tap, read `conversationId` from `userInfo` and join with it. Port the flow from the spike's `answerFromNotification()` and `rejoinOnFreshStream()` in `SpikeController.swift`, which already join on the stream request; only the ID source changes.
6. **Measure on the watch (never under Xcode's debugger):**
   - push sent → notification shown, for a suspended app and for a quit app;
   - tap → first audio;
   - whether the `voip` background mode is needed: remove it from `app/Config/Watch-Info.plist` and check that incoming audio still plays with the wrist down and that the app survives a long quiet spell in the 45 s window. Option C doesn't use PushKit, so App Review may question it;
   - the same flow on watchOS 9–11 (older simulator runtimes, or a spare watch): whether the Opus encoder exists there (`VoiceEncoder` silently falls back to 256 kbps PCM) and whether the notification still launches the app in the background;
   - whether time-sensitive notifications get through Focus modes.

   Record the results in the doc.

## Decisions made (2026-09-25)

Logged in the doc's Design decisions table.

- **Project:** a new Xcode project in `app/` (iPhone app + watch app), with shared code in the local package `app/Packages/OverAndOutKit`. `RelayConnection`, `VoiceCodec` and `AudioPipeline` are already ported there, with tests (`swift test`). The answer / join / conversation-window logic and the audio session setup aren't ported yet.
- **iPhone app:** a companion in the MVP (sign-in, invites, friends, settings). PushToTalk comes after the MVP.
- **MVP core:** Sign in with Apple, invite links over Messages, one-to-one channels, a fixed 45 s window, report/block, account deletion. No async clips; unheard audio is still dropped.
- **Bundle ID:** `com.cypressoakstudios.overandout` (the watch app is `….watchkitapp`).
- **Minimum OS: iOS 16 / watchOS 9**, the lowest the APIs need, so people on older OSes can talk to people on watchOS 27. It's also the lowest Xcode 27 can target for watchOS, and a watch on watchOS 9 pairs with iOS 16 or later. Everything the MVP uses is older (time-sensitive notifications watchOS 8, `WKApplication` remote notifications watchOS 7, Sign in with Apple watchOS 6). The spike's watch code needed watchOS 10 in only two places: `AVAudioApplication.requestRecordPermission` (use `AVAudioSession.requestRecordPermission` below watchOS 10) and the `topBarTrailing` toolbar placement. Gate newer features with `#available`: double-tap (`handGestureShortcut`) needs watchOS 11, and Control widgets need watchOS 26.
- **Still open:** hosting at scale (the doc's Hosting section has Cloud Run, Memorystore and Firestore; the spike runs on one e2-micro VM).

## What to reuse from the spike

- **Relay** (`server/`, Node 24+, TypeScript run directly, no dependencies; `npm test` runs 19 tests, all passing):
  - `src/relay.ts`: floor control, buffering and replay, ring timers, join including `"pending"`.
  - `src/main.ts`: the HTTP API and HTTP transport (`/v1/relay/stream` with `?join=`, `/v1/relay/send`); the WebSocket is for bots and tests.
  - `src/records.ts`: the length-prefixed record framing.
  - `src/apns.ts`: the APNs client (JWT, HTTP/2); extend it for alert pushes.
  - `src/report.ts`, `tools/report.ts`, `tools/bot.ts`, `tools/client.ts`: timelines and a scripted peer. These stay useful for testing.
- **Watch:**
  - `RelayConnection.swift`: the HTTPS transport. It queues sends until the stream's hello-ack, and supports `join`.
  - `AudioPipeline.swift`: `AVAudioEngine` capture and playback, a jitter buffer, and a restart after configuration changes.
  - `VoiceCodec.swift`: Opus through `AVAudioConverter`.
  - The audio session setup and the answer / join / conversation-window logic in `SpikeController.swift`.
- **Drop:**
  - the CallKit option B code: the `CXProvider` hand-off, `ringWithCallKit`, and PushKit/`PushService.swift`;
  - ring polling and `poll:` tokens;
  - the local-notification test (Settings → Experiments, `NotificationRingTest`);
  - the `"pending"` join, which is only for that test;
  - the spike token auth. The product needs real accounts.

  Keep the timeline diagnostics until the product has its own telemetry.

## Open risks carried into the build

- **Long quiet spell mid-conversation:** the app stayed alive with its audio session on for at least ~22 s in the background. Whether watchOS suspends it during a longer silence inside the 45 s window is untested.
- **The fallbacks haven't run on a device:** rejoining on a fresh stream when the launch-time stream went stale, and "no pending ring" leading to polling.
- **An app that's only suspended** isn't launched when the notification arrives. Its tap → first audio is ~2.8 s, versus ~2.5 s from a cold start.
- **Notification Service Extension on watchOS:** whether one is available, which could prefetch audio, is unverified.
- **App Review:** see the doc's "App Store, privacy and business" section. Option C avoids the CallKit concern.

## Deployment (Google Cloud)

- **Resources:** project `walkie-talkie-relay` (owned by stevelt@gmail.com); VM `walkie-relay` (e2-micro, Debian 13, us-central1-a, static IP `35.209.96.216`); firewall rule `walkie-web` (80/443).
- **DNS:** `walkie.cypressoakstudios.com`, an A record at GoDaddy.
- **Stack:** Caddy (Let's Encrypt, HTTP/2, `flush_interval -1`) in front of Node on 127.0.0.1:8080, as the systemd service `walkie`. Releases are under `/opt/walkie/releases/`.
- **Deploy:** commit, then run `deploy/gcp/deploy.sh`, which ships **committed** code only. `gcloud` is at `~/google-cloud-sdk/bin`, which isn't on the agent shell's PATH, so prefix `export PATH=$HOME/google-cloud-sdk/bin:$PATH`. Running now: `9a636ba`; later commits changed only the watch app and docs.
- **Logs:**

  ```bash
  gcloud compute ssh walkie-relay --zone=us-central1-a --project=walkie-talkie-relay -- sudo journalctl -u walkie -n 100
  ```
- **Registered users:** `watch-abee` (Steve's watch), `bot` ("Test Bot"), and the test users `smoke-listener`, `smoke-sender`, `smoke-http`. There's no delete endpoint.
- **Project list lag:** the project may not show in `gcloud projects list`, but it works by ID.

## Local config (gitignored; don't commit or print)

- `deploy/gcp/config.sh`: `PROJECT_ID`, `DOMAIN`, the generated `SPIKE_TOKEN`, and empty `APNS_*` values.
- `app/Config/Local.xcconfig`: the Personal Team, `OAO_BUNDLE_ID = com.cypressoakstudios.overandout.dev` and `OAO_PUSH = no`, until the paid membership is active.
- `watch/Config/Local.xcconfig`: `DEVELOPMENT_TEAM = V5A3D25UYP` (the **free Personal Team**; replace it), `PRODUCT_BUNDLE_IDENTIFIER = com.cypressoakstudios.walkiespike.dev`, `SPIKE_SERVER_HOST = walkie.cypressoakstudios.com`, `SPIKE_TOKEN`, and `SPIKE_PUSH_MODE = none`. `voip` selects the push entitlement file; option C will need an alert-push equivalent.
- To use the token in commands without printing it:

  ```bash
  grep -o 'SPIKE_TOKEN="[^"]*"' deploy/gcp/config.sh | cut -d'"' -f2
  ```

## Testing on the watch

- **Hardware:** Steve's watch is on watchOS 27, UDID `00008320-0013043A1E60000A`, user `watch-abee`, paired with an iPhone.
- **Install and run:**
  1. Steve installs from Xcode, then clicks **Stop**, and opens the app on the watch.
  2. Ring it with the bot. From `server/`, with `SPIKE_SERVER=https://walkie.cypressoakstudios.com` and `SPIKE_TOKEN` set as above:

     ```bash
     node tools/bot.ts send --to watch-abee --name "Test Bot" --say "…" --ring-until-answered --stay 30
     ```

     Run it in the background. `--again N` sends a second message N s after the watch joins.
  3. Print the timeline with `node tools/report.ts [conversationId]`. It includes notification, launch, preconnect, join, audio and Talk marks, plus `processPaused` / `mainStall` / `app` state diagnostics.
- **The watch uploads its timeline when the conversation ends.** Ask Steve to tap **End** so you don't have to wait for the 45 s window.
- **Until push works,** Settings → Experiments has "Notification ring in 30 s" and "…then quit". The second is the only way to test a cold start: watchOS 27 has no app switcher, and double-clicking the crown doesn't open one.

## Simulator

- **Devices:** Apple Watch Series 12 (46mm) sim `5DE92663-5226-41E6-9799-2C68705F50F7`, user `watch-b25f`, with Test Bot selected. It has no microphone (it sends a 440 Hz test tone), no push, and no incoming CallKit calls.
- **Local relay:**

  ```bash
  cd server && PORT=8080 DATA_DIR=<dir> SPIKE_TOKEN=simtoken node src/main.ts
  ```

  The sim app has `localhost:8080` saved in its own settings, and `simctl spawn … defaults write` does **not** change it.
- **Build:**

  ```bash
  xcodebuild -project watch/WalkieSpike.xcodeproj -target WalkieSpike -sdk watchsimulator SPIKE_SERVER_HOST=localhost:8080 SPIKE_TOKEN=simtoken SYMROOT=<dir> build
  ```

  Then `xcrun simctl install` it and launch `com.cypressoakstudios.walkiespike.dev`.

## Gotchas

- **Never measure timing under Xcode's debugger.** Over the watch's wireless link it stops the whole app for 1–20 s whenever a system library loads, such as the first haptic, audio session or recording. That was the "Talk button freeze" in runs 3–7.
- **Xcode can't always reach the watch** (`CoreDeviceError 4000`, "Timed out … establish tunnel"). Wake and unlock the watch and the iPhone, put them on the same Wi-Fi as the Mac, and wait for the watch in Devices and Simulators. Restart them if needed. Don't run `devicectl` while Steve is using Xcode.
- **Xcode keeps stale settings:** if Run launches `com.example.walkiespike`, reopen the project, and use Clean Build Folder for stale files.
- **Simulator builds need their ad-hoc signature** (don't pass `CODE_SIGNING_ALLOWED=NO`). For device compile checks, it's fine.
- **No `timeout` on macOS:** use `perl -e 'alarm N; exec @ARGV'`.
- **Stage files by name,** never `git add -A`.

## Steve's preferences

- **Hosting:** Google Cloud only, among AWS, Azure and Google Cloud. No Cloudflare or other new providers.
- **Git:** commit or push only when asked. Committing locally in order to deploy is fine.
- **Doc:** record design decisions and results in the feasibility doc so they can be revisited.
- **Secrets:** never print the `SPIKE_TOKEN` (or, later, APNs keys).
