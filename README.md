# Walkie-Talkie ring-to-start spike

A prototype for the first item on the feasibility study's spike checklist: can a watch app use VoIP push and CallKit to ring once per conversation, replay the sender's first words after the user answers, and then play later messages instantly until the conversation goes quiet? It also measures how long each step takes.

```
server/      Relay + APNs push server (Node 24+, no dependencies)
watch/       Watch-only app (watchOS 26+, SwiftUI, CallKit, PushKit)
deploy/gcp/  Scripts to host the server on a Google Cloud e2-micro VM
```

## How it works

1. The sender presses Talk. The relay buffers the audio and rings the recipient's watch, by push or, without push, by the app checking the server while it's open.
2. The watch shows a CallKit incoming call. CallKit is used **only to ring**: watchOS locks the screen into the system call UI for as long as a call is active, which would hide the Talk button ([Apple DTS](https://developer.apple.com/forums/thread/818140)). So when the user answers, the app ends the call right away and is back on screen.
3. The app turns on its own audio session, tells the relay it answered, opens the relay stream and sends `join`. The relay replays the buffered audio, then forwards the rest live.
4. Later messages play instantly. After `conversationWindowSeconds` of silence (45 s by default), the conversation ends.

If nobody answers, the watch stops ringing at 30 s. At 35 s the relay drops the audio nobody heard and tells the sender, so the next Talk starts a new ring instead of replaying old audio. That timer restarts when a polling watch collects the ring. Once the watch reports it answered, it has 30 s to join.

Audio is Opus at 24 kbps in 20 ms frames, using Apple's built-in encoder. If a device can't create an Opus encoder, the app falls back to raw 16 kHz PCM, and the log in the app's Settings says which one it's using. The relay forwards frames without decoding them.

The watch talks to the relay over plain HTTPS: a long-lived `GET /v1/relay/stream` for the relay-to-watch direction, and back-to-back `POST /v1/relay/send` batches for the watch-to-relay direction. It can't use a WebSocket, because watchOS only allows those during a CallKit call ([TN3135](https://developer.apple.com/documentation/technotes/tn3135-low-level-networking-on-watchos)), and conversations happen after the call has ended. The bots and tests can use either transport.

## One-time setup

**Apple Developer account**

1. Create an App ID for your bundle ID, for example `com.yourname.walkiespike`, with Push Notifications enabled. Xcode's automatic signing will do this if the team has permission.
2. Create an APNs auth key (`.p8`) under Certificates, Identifiers & Profiles → Keys. Note the key ID and your team ID.

**Server**

```bash
cd server
npm test
```

Run the server with APNs credentials and a shared token:

```bash
SPIKE_TOKEN=choose-a-long-random-string APNS_KEY_PATH=~/keys/AuthKey_ABC123.p8 APNS_KEY_ID=ABC123 APNS_TEAM_ID=ABCDE12345 APNS_BUNDLE_ID=com.yourname.walkiespike npm start
```

Without the `APNS_*` variables, the server runs in dry-run mode and only logs pushes. The watch has to reach the server over HTTPS, including on LTE, so it needs a public host. Deploy it to Google Cloud with the scripts in [deploy/gcp](deploy/gcp/README.md). They set up an e2-micro VM with automatic HTTPS for about $3.65 a month, and read the token and APNs settings from `deploy/gcp/config.sh`.

Always set `SPIKE_TOKEN` when the server is reachable from the internet.

**Watch app**

1. Copy `watch/Config/Local.xcconfig.example` to `watch/Config/Local.xcconfig` and fill in your team ID, bundle ID, server host (no `https://`) and token. `APNS_BUNDLE_ID` on the server must match the bundle ID.
2. Open `watch/WalkieSpike.xcodeproj`, select your watch as the destination, and run.
3. On the watch, allow the microphone. The app registers its VoIP token with the server automatically, and Settings shows "Registered as watch-xxxx".
4. In Settings → Talk to, pick who to talk to. The list shows every other registered device, including bots.

Debug builds use the APNs sandbox environment, and Release builds use production.

## Running the spike

With one watch, use the bot as the other person:

```bash
cd server
export SPIKE_SERVER=https://walkie.example.com SPIKE_TOKEN=choose-a-long-random-string
npm run bot -- send --to watch-xxxx --say "Hi, this is a ring-to-start test. Over."
npm run bot -- listen --answer-delay 1500
npm run report
npm run report -- --all
```

- `bot send` rings the watch and speaks. With the watch app not running, answer the ring and you should hear the whole sentence.
- `bot listen` answers like a watch would. Pick "Test Bot" on the watch and hold Talk to test the watch as the sender.
- `npm run report` prints the latest conversation's timeline and intervals.
- `npm run report -- --all` prints every run, plus medians.

With two watches, install the app on both, pick each other in Settings, and hold Talk on one.

Test each run in each of these network conditions:

| Condition | How |
| --- | --- |
| Through the paired iPhone | iPhone nearby, as normal |
| Watch Wi-Fi only | On the iPhone, turn off Wi-Fi and Bluetooth in **Settings** (not Control Center) |
| Watch LTE only | Same as above, out of range of known Wi-Fi |
| Cold start | Remove the app from the watch's app switcher before the run |
| Inside the conversation window | Talk again within 45 s. There's no ring, so measure the delay until the reply plays |

The report's key numbers:

- **Watch: answer → first audio**: the technical delay after the user answers. Target: under 1 s.
- **Push sent → watch woke**: APNs delivery time. This crosses devices, so it depends on the clock-offset estimate.
- **Total: press → first audio**: what the sender experiences, including the time the recipient takes to answer.

## Testing on a watch before your membership is active

A free Apple account (Xcode's "Personal Team") can install the app on your own watch, but it can't include the Push Notifications entitlement. Build with `SPIKE_PUSH_MODE = none`. That build has no push entitlement, and while the app is open it checks the server for rings every 1.5 s. A ring still goes through real CallKit, so the system ringing screen, answering, audio and networking are all real. The only thing missing is a push waking the app when it's closed.

1. In Xcode → Settings → Accounts, add your Apple ID. This creates a Personal Team.
2. In `watch/Config/Local.xcconfig`, set:
   - `DEVELOPMENT_TEAM` to the Personal Team's ID
   - a unique `PRODUCT_BUNDLE_IDENTIFIER`
   - your server host in `SPIKE_SERVER_HOST`, and `SPIKE_TOKEN`
   - `SPIKE_PUSH_MODE = none`
3. Deploy the server with [deploy/gcp](deploy/gcp/README.md), leaving the `APNS_*` settings empty.
4. On the watch, turn on Developer Mode (Settings → Privacy & Security → Developer Mode). Then run from Xcode with the watch as the destination. If the watch says the developer isn't trusted, trust your Apple ID's developer profile under VPN & Device Management in Settings.
5. Keep the app on screen while being rung. It only checks for rings while it's open, so raise your wrist or tap the screen. Settings → Server → Rings shows "Polled (app open)".

What this can measure on real hardware: the ringing screen and answering, including whether double-tap answers; whether the app comes back on screen when the call ends after answering; how long the app's own audio session and the HTTPS relay take to start; real microphone and Opus audio quality; Wi-Fi, LTE and paired-iPhone networking; whether the paired iPhone shows anything; and battery use per conversation. What it can't measure: VoIP push delivery and waking from closed. Free provisioning also expires after 7 days, so re-run from Xcode to renew it.

The server now sends option C rings: a time-sensitive **alert** push to the bundle ID topic, not a VoIP push. So `SPIKE_PUSH_MODE = voip` no longer works end to end. When your membership is active, the watch needs to register for remote notifications instead (step 5 of "First steps with the membership" in [HANDOFF.md](HANDOFF.md)).

## Running in the simulator

The watch simulator can run the whole flow against a local server without an Apple Developer account. Start the server without APNs credentials, so it runs in dry-run mode:

```bash
cd server && SPIKE_TOKEN=simtoken npm start
```

Build and install with the local host baked in:

```bash
cd watch && xcodebuild -project WalkieSpike.xcodeproj -target WalkieSpike -sdk watchsimulator SPIKE_SERVER_HOST=localhost:8080 SPIKE_TOKEN=simtoken build
```

Then install `build/Debug-watchsimulator/WalkieSpike.app` with `xcrun simctl install`. Don't pass `CODE_SIGNING_ALLOWED=NO` for simulator builds: CallKit needs the local ad-hoc signature and rejects unsigned apps as "unentitled". Use the bot commands from above with `SPIKE_SERVER=http://localhost:8080`.

The simulator can't do several things a real watch does. Simulator builds work around them, so some of their timings aren't meaningful:

| Simulator limitation | Workaround in simulator builds | Timing affected |
| --- | --- | --- |
| No VoIP token or VoIP pushes | Registers a `poll:` token and collects rings from `/v1/rings/poll` every 1.5 s | "Push sent → watch woke" is polling delay, not APNs |
| Incoming CallKit calls are disconnected right away (reason 55), and there's no ringing screen | The ring stays inside the app, with Answer and Decline buttons that run the same code as CallKit's answer | Ring UI is only testable on a watch |
| No microphone | Sends a 440 Hz test tone while Talk is held | None |
| No system call screen to return from after answering | None | Whether the app comes back on screen must be tested on a watch |

The app's own audio session, the HTTPS relay transport, Opus encoding and decoding, replay, the conversation window and metrics all behave as they do on a device.

## Not in this spike yet

- Voice clips for unanswered rings, Do Not Disturb and Theater Mode. This is deferred by design: the watch stops ringing at 30 s, then at 35 s the relay drops the unheard audio and tells the sender "didn't answer". See "Design decisions" in the feasibility doc for why, and when to revisit.
- Checking that the paired iPhone shows nothing, and whether double-tap answers the call. Watch for both during runs.
- Battery measurement per conversation. Use the watch's battery level before and after a scripted series of runs.
- iPhone PushToTalk, real accounts (Sign in with Apple), group channels and end-to-end encryption.
