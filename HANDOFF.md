# Handoff: Walkie-Talkie spike (state as of 2026-09-23, evening)

Read this first when picking the work back up. It records what's built, what's deployed, what the real-watch tests showed, and what to do next. There are no secrets in this file. Tokens and keys live in gitignored files, listed under Local config.

## Goal

Build a third-party replacement for Apple's Watch Walkie-Talkie app, which was removed in watchOS 27. We're currently running the spike: proving on real hardware that a watch can be rung, answered, and hold a push-to-talk conversation.

- **Feasibility doc (Claude Docs):** https://claude.ai/code/artifact/59ab6e47-6e5d-4698-8bd1-173293953df9. Its sections include Prototype results, Hosting, Design decisions and Risks. Log new design decisions in its "Design decisions" table (date, decision, why, revisit if).
- **Repo:** https://github.com/stevetex/WalkieTalkie. `main` is **2 commits ahead of origin**, not pushed: `0aeb71a` (speed-ups) and `bc6cce3` (audio recovery, in-app ring, diagnostics).

## Decision: option C (2026-09-23)

Steve dropped option B as too kludgey for a commercial app. **Option C is the design:** ring with a time-sensitive notification that opens the app, with no CallKit on the watch. It's logged in the doc's Design decisions. The conversation path below (app's own audio session, HTTPS relay) is the same in both. Option C's push can't be tested until the Apple Developer Program membership is approved, so a **local notification stands in for it** (see "Notification ring test").

## Previous design ("option B"), kept in the code for comparison

- **The watch uses CallKit only to ring.** watchOS locks the screen into the system call UI for as long as a CallKit call is active. We confirmed that on hardware, and Apple DTS confirms it in https://developer.apple.com/forums/thread/818140. So on answer, the app ends the call at once and is back on screen.
- **The conversation runs in the app over plain HTTPS.** WebSockets are only allowed during a call (TN3135).
  - Downlink: `GET /v1/relay/stream`, a long-lived response of length-prefixed records (`server/src/records.ts`).
  - Uplink: back-to-back `POST /v1/relay/send` batches.
  - Bots and tests can also use the older WebSocket at `/v1/relay`.
- **The app turns on its own `AVAudioSession`** (playAndRecord, voiceChat). Audio is Opus at 24 kbps in 20 ms frames, via `AVAudioConverter`.
- **Relay behavior:**
  - It buffers the sender's burst and replays it when the recipient joins.
  - The watch stops ringing at 30 s. At 35 s the relay drops the unheard audio and sends `ring-timeout`.
  - The watch reports "answered" over HTTPS (`POST /v1/rings/answer`), which gives it 30 s to join.
  - Polled rings restart the timer when they're collected.
  - Conversations end after 45 s idle.
- **Push today:** the membership is pending, so there's no push yet. The watch is built with `SPIKE_PUSH_MODE = none`, registers a `poll:` token, and polls `GET /v1/rings/poll` every 1.5 s while the app is open.

## Repo layout (key files)

- `server/`: Node 24+, TypeScript run directly, no dependencies. `npm test` runs 18 tests, all passing.
  - `src/relay.ts`: floor control, buffering and replay, ring timers, polled rings.
  - `src/main.ts`: HTTP API, the HTTP relay transport, the WebSocket.
  - `src/apns.ts`: VoIP pusher, dry-run without a key.
  - `src/report.ts`: per-ring timing intervals.
  - `tools/bot.ts`: scripted sender or listener.
  - `tools/report.ts`: prints timelines.
  - `tools/client.ts`: Node client, `transport: "ws" | "http"`.
- `watch/`: watch-only app (watchOS 26+), with a hand-written `project.pbxproj` using a synchronized folder.
  - `WalkieSpike/SpikeController.swift`: the whole flow, including rings, the CallKit hand-off, the audio session, talk, diagnostics.
  - `RelayConnection.swift`: HTTPS transport.
  - `AudioPipeline.swift`, `VoiceCodec.swift`: audio.
  - `SpikeSettings.swift`: settings, `ringsInApp`, push mode.
  - `Config/Base.xcconfig`: includes `Local.xcconfig`.
- `deploy/gcp/`: `create-vm.sh`, `deploy.sh` (ships **committed** code only), `provision.sh`, and `README.md`, the setup guide.

## Deployment (Google Cloud)

- **Resources:**
  - Project `walkie-talkie-relay`, owned by stevelt@gmail.com and billed to "My Billing Account".
  - VM `walkie-relay` (e2-micro, Debian 13, us-central1-a), static IP `35.209.96.216`.
  - Firewall rule `walkie-web` (80/443).
- **DNS:** `walkie.cypressoakstudios.com`, an A record at GoDaddy.
- **Stack:** Caddy with Let's Encrypt and `flush_interval -1`, in front of Node on 127.0.0.1:8080 as the systemd service `walkie`.
- **Project list lag:** the project doesn't show in the console or `gcloud projects list` yet, a search-index lag, but it works by ID: https://console.cloud.google.com/home/dashboard?project=walkie-talkie-relay
- **Deploy:** commit, then `deploy/gcp/deploy.sh`.
  - `gcloud` is at `~/google-cloud-sdk/bin`, which isn't on the agent shell's PATH, so prefix `export PATH=$HOME/google-cloud-sdk/bin:$PATH`.
- **Logs:**

  ```bash
  gcloud compute ssh walkie-relay --zone=us-central1-a --project=walkie-talkie-relay -- sudo journalctl -u walkie -n 100
  ```
- **Registered users on the live server:** `watch-abee` (Steve's real watch), `bot` ("Test Bot"), and test users `smoke-listener`, `smoke-sender`, `smoke-http`. There's no delete endpoint.

## Local config (gitignored, don't commit or print)

- `deploy/gcp/config.sh`: PROJECT_ID, DOMAIN, and the generated `SPIKE_TOKEN`. ACME_EMAIL is empty, and APNs isn't set up yet.
- `watch/Config/Local.xcconfig`:
  - `DEVELOPMENT_TEAM = V5A3D25UYP` (free Personal Team)
  - `PRODUCT_BUNDLE_IDENTIFIER = com.cypressoakstudios.walkiespike.dev`
  - `SPIKE_SERVER_HOST = walkie.cypressoakstudios.com`
  - `SPIKE_TOKEN` (the same token)
  - `SPIKE_PUSH_MODE = none`
- To read the token for commands without printing it:

  ```bash
  grep -o 'SPIKE_TOKEN="[^"]*"' deploy/gcp/config.sh | cut -d'"' -f2
  ```

## How to run a test on the real watch

1. Steve runs the build on the watch from Xcode (a Series 12-era watch on watchOS 27, UDID `00008320-0013043A1E60000A`). He keeps the app on screen with **Test Bot** selected.
2. Ring it:

   ```bash
   cd server && SPIKE_SERVER=https://walkie.cypressoakstudios.com SPIKE_TOKEN=$(grep -o 'SPIKE_TOKEN="[^"]*"' ../deploy/gcp/config.sh | cut -d'"' -f2) node tools/bot.ts send --to watch-abee --name "Test Bot" --say "…" --stay 60
   ```

   Run it in the background; it prints bursts received from the watch.
3. Afterwards, print the timeline:

   ```bash
   node tools/report.ts <conversationId>
   ```

   Use the same env vars. The timeline now includes `micFirstFrame`, `post1..3`, `mainStall`, `log`, `floorGrantSent`, `clockSynced`, and `callKitAudioActivated`/`Deactivated`.

## Simulator testing

- **Devices:** Apple Watch Series 12 (46mm) sim `5DE92663-5226-41E6-9799-2C68705F50F7`, paired with iPhone 18 Pro Max. The sim app is user `watch-b25f`, with Test Bot selected.
- **Local server:**

  ```bash
  cd server && PORT=8080 DATA_DIR=<scratch dir> SPIKE_TOKEN=simtoken node src/main.ts
  ```
- **Build:**

  ```bash
  xcodebuild -project watch/WalkieSpike.xcodeproj -target WalkieSpike -sdk watchsimulator SPIKE_SERVER_HOST=localhost:8080 SPIKE_TOKEN=simtoken SYMROOT=<dir> build
  ```

  Then use `xcrun simctl install` and launch **`com.cypressoakstudios.walkiespike.dev`**. Local.xcconfig sets the bundle ID. An old `com.example.walkiespike` copy may still be on the sim; ignore it.
- **Simulator limitations:** no VoIP push, no microphone (sends a 440 Hz test tone), and it can't show incoming CallKit calls, so rings are always in-app.

## Real-watch results so far

| Run | Design | Result |
| --- | --- | --- |
| 1 | Call + WebSocket | Message lost (ring collected 28 s late, socket 6.8 s after answer, relay timed out). Fixed by the answer report and restarting the timer on collection |
| 2 | Same, fixed | Heard it (answer → audio 5.4 s), but stuck in the system call UI with no way to reach the Talk button |
| 3 | Option B | **Worked:** back in the app, heard it (3.1 s), 2 replies received. The first reply stalled 12.7 s |
| 4 | Option B + speed-ups | **Worse:** CallKit confirmed the ring 5.5 s late, after the answer. CallKit activated call audio ~6 s *after* the call was ended, and that silenced playback: Steve didn't hear it, and 3 replies had 0 frames. Slow return to the app. The Talk button did nothing for seconds, with "go ahead" arriving ~20 s late |
| 5 | Option B, `bc6cce3` (audio reclaim) | Worked: heard it, 2 replies with audio. Answer → first audio 6.9 s (CallKit held audio 5.7 s). First Talk press froze ~22 s |
| 6 | In-app ring ("Ring with CallKit" off) | Worked: answer → first audio 3.0 s, 2 replies. First Talk press froze ~18 s |
| 7 | Same | Same ~18 s freeze. The mic, network callbacks and a background timer all stopped: the whole process was stopped |
| 8 | Same, **launched on the watch without Xcode** | **No freeze.** Answer → first audio 1.0 s, answer → audio session 62 ms, Talk → mic 24 ms, Talk → "go ahead" 270 ms |
| 9 | Notification ring test, app in background | Worked. Tap → first audio 5.2 s (collect ring 2.5 s, open stream, join: three serial HTTPS requests on a waking network). **Second message played with the wrist down**; the app ran in the background while its audio session was on, and was suspended after the conversation ended (its metrics upload waited until reopened) |
| 10 | Same, app quit first (cold launch) | Worked. Tap → first audio 4.7 s. watchOS appears to launch the app in the background when the notification is delivered (process start 0.4 s after delivery, then paused until the tap), so launch time is hidden. Reply: Talk → "go ahead" 0.96 s |
| 11 | Same, one-request answer (`7816d8c`, cold launch) | Worked, "played almost immediately". Tap → first audio **2.9 s**; the stream request took 1.9 s to reach the server on a waking network, and the reply 0.8 s to come back. Reply: Talk → "go ahead" 0.38 s |

**The Talk freeze (runs 3–7) was Xcode's debugger**, not the app: over the watch's wireless link it stops the whole process for 1–20 s whenever a system library loads (first haptic, audio session, first recording). Runs 3–7 and all CallKit timings were measured under the debugger.

Commit `bc6cce3` was the response to run 4. It opens the relay on ring arrival, reclaims audio on CallKit deactivation or interruption, restarts the engine on configuration change, adds the **"Ring with CallKit" toggle** (Settings → Server, polling mode) to ring in-app with no CallKit, adds the Talk button's gray "Wait…" state, and adds the diagnostics. It's built and simulator-tested, **but not yet tested on the watch.**

## Uncommitted work (as of 2026-09-23)

- **Diagnostics:** `app` marks (active/inactive/background/foreground, from `WKApplicationDelegate`), a `processPaused` mark when the watchdog's own timer misses ticks by over 1 s (whole process stopped), every Talk press/release logged, `burstStartReceived`/`burstAudioStarted` logged per burst.
- **Notification ring test:** Settings → Experiments → "Notification ring in 30 s" (`armNotificationRing` in `SpikeController.swift`). It schedules a local time-sensitive notification and pauses ring polling. Opening the notification polls at once and answers the next ring automatically, adding `notificationScheduled`/`Delivered`/`Opened` (and `appLaunched` on a cold launch) to the timeline. Personal Teams lack the time-sensitive entitlement, so it's delivered as "active".
- **Bot:** `--ring-until-answered` re-rings after each 35 s ring timeout until the server shows `receiverJoined`; `--again N [--say-again "…"]` sends a second message N s after that.
- **Report:** notification intervals in `server/src/report.ts` (only `tools/report.ts` uses them, so no deploy needed).
- Simulator-tested: opened → ring collected 16 ms, opened → first audio 165 ms.

## Next steps

1. **Measure joining over a stream opened before the tap.** Run 11 (one-request answer): tap → first audio 2.9 s, ~1.9 s of it the request reaching the server on a cold network. watchOS seems to launch the app in the background when the notification is delivered, so now, when the app launches while a test notification is armed, it opens the relay stream right away (`preconnectStarted`/`preconnected` marks), and the tap sends `join` (conversation "pending", handled in `Relay.join`) over it. If that stream went stale while suspended (closed, or not joined within 3 s), it rejoins once on a fresh stream with `?join=pending`. Simulator: opened → joined 86 ms. The stale-stream fallback and the no-pending-ring fallback haven't been exercised on a device. This only helps a cold launch; an app already suspended in the background isn't woken on delivery. Run 12 (app merely suspended, not quit) took the run-11 path: 2.8 s. To test a cold launch, use Settings → Experiments → "Notification ring in 30 s, then quit" (it calls `exit(0)`; watchOS 27 has no app switcher). Real option C passes the conversation ID from the push payload instead of "pending".
2. **Wrist down:** audio played and the app kept running while its audio session was on (run 9). Still untested: a long quiet spell mid-conversation, which is when watchOS might suspend it.
3. **When the membership is approved:** APNs key, a real time-sensitive push for option C, and measure push → notification on a closed app.
4. **Optional:** decode the watch's Opus on the Mac to a WAV file, to check microphone quality.
5. **Update the doc's Prototype results** after each run, and push the local commits when Steve asks.

## Gotchas

- **Never measure timing under Xcode's debugger.** On the watch it stops the whole app for 1–20 s whenever a system library loads. Run from Xcode to install, click Stop, then open the app on the watch.

- **Xcode's stale settings:** Xcode can keep old build settings. If Run launches `com.example.walkiespike`, close and reopen the project. Use Product → Clean Build Folder if the bundle has stale files (Local.xcconfig was once bundled by accident; that's fixed).
- **Simulator builds need their ad-hoc signature:** don't pass `CODE_SIGNING_ALLOWED=NO` for simulator builds, or CallKit rejects the app as "unentitled". It's fine for device compile checks.
- **Watch connections are flaky:** Xcode and `devicectl` connections to the watch time out easily. Don't run `devicectl` while Steve is using Xcode.
- **No `timeout` on macOS:** use `perl -e 'alarm N; exec @ARGV'` instead.
- **Stage files explicitly:** stage files by name; `git add -A` once picked up an Xcode project change by accident.

## Steve's preferences

- **Hosting:** Google Cloud only, among AWS, Azure and GCP. No Cloudflare or other new providers.
- **Git:** commit or push only when asked. `deploy.sh` needs committed code, so committing locally in order to deploy is accepted.
- **Doc:** record design decisions in the doc so they can be revisited.
