# Handoff: Over&Out — option E relay infrastructure (2026-09-26)

Read this first. Over&Out: Watch Walkie Talkie replaces Apple's Watch Walkie-Talkie app, which Apple removed in watchOS 27. The watch app works end to end on Steve's watch with real APNs pushes. The next job is the at-scale hosting design, option E, starting with its infrastructure (steps 1–3 below). There are no secrets in this file. Tokens and keys live in gitignored files, listed under Local config.

## Start here

1. Read this file, then the feasibility doc: its **Hosting** section (option E and the options it beat), **Design decisions** (especially the 2026-09-25 and 2026-09-26 rows), and **Prototype results** runs 16–22.
2. Do **option E steps 1–3**: Firestore for server data, a relay container image, and a managed instance group. Steps 4–6 (protocol, apps, two-node test) come after.
3. Ask Steve before anything outward-facing or billed: creating Google Cloud resources, deploying to the live relay, DNS changes (he adds GoDaddy records by hand), and deleting the old VM.

## Links

- **Feasibility doc (Claude Docs):** https://claude.ai/code/artifact/59ab6e47-6e5d-4698-8bd1-173293953df9. Log design decisions in its Design decisions table (date, decision, why, revisit if), and measured results in Prototype results.
- **Repo:** https://github.com/stevetex/WalkieTalkie. `main` is pushed and clean.
- **App name and domain:** "Over&Out: Watch Walkie Talkie", overandout.app. Bundle IDs `com.cypressoakstudios.overandout` and `com.cypressoakstudios.overandout.watchkitapp`.

## Where things stand

- **Product app (`app/`, see [app/README.md](app/README.md)):**
  - An iPhone companion app (placeholder for now) and a watch app, iOS 16 / watchOS 9 minimum. Shared code is in the local package `app/Packages/OverAndOutKit` (relay transport, Opus codec, audio pipeline, timeline, ring payload; `swift test`).
  - The watch's conversation flow is in `app/Watch/ConversationController.swift`:
    - answer from the notification, or in the app with pre-connect;
    - join in the stream request, talk, and the fixed 45 s window;
    - the app's own audio session; no background modes.
  - Until accounts exist, the watch uses a dev identity: a generated user ID, the relay's shared token from `Local.xcconfig` (`OAO_SERVER_TOKEN`), and a friend picked in Settings.
- **Relay (`server/`):**
  - Node 24+, TypeScript run directly, no dependencies; `npm test` runs 27 tests.
  - It sends time-sensitive **alert** pushes (`ringAlert()` in `src/apns.ts`) to the watch app's topic. There are no VoIP pushes any more.
  - `SIMULATOR_PUSH=1` delivers rings to simulators with `xcrun simctl push` (development only).
  - Deployed: `fca101f` on the `walkie-relay` VM, with the APNs key.
- **Membership:** active. Xcode registered Steve's devices and created the profiles; the watch App ID has Push Notifications and Time Sensitive Notifications.

### Measured on Steve's watch (no debugger, real APNs; runs 16–22 in the doc)

| What | Result |
| --- | --- |
| Push sent → notification on the watch | 0.03–0.3 s |
| Tap on notification → first audio | 2.9–3.4 s. The first request after the tap takes 2.0–2.5 s (the watch's network waking up) |
| Answer in the app → first audio, with pre-connect | **0.95 s** (run 22), down from 3.06 s |
| Cold start (app quit before the ring) | No extra delay (3.24 s) |
| Wrist down and quiet spells | Plays with the wrist down and survives 35 s of silence with **no** background modes (run 21) |
| Do Not Disturb | Rings break through only if Over&Out is on the Focus's allowed apps. Onboarding will guide users to that |
| Talk → relay's "go ahead" | 0.3–0.37 s |

## Option E (decided 2026-09-26)

Each conversation runs on **one relay node**, and both apps connect to it, so `relay.ts` keeps its state in memory as it does now.
- **Choosing a node:** both apps rank the nodes by rendezvous hashing over a fixed node list, and the ring notification names the node.
- **The apps own what matters:** the sender's app keeps unheard messages until they're delivered and re-sends them after a failover. So a node is a disposable cache, with no Valkey, no pub/sub and no node directory.
- **Firestore, off the audio path:** accounts, friends, blocks and push tokens.
- **Nodes:** VMs in a **managed instance group** on **Container-Optimized OS**, so restarts and OS updates are automatic.
- **Cost:** ~$4 a month for the Beta (a free-tier e2-micro; only the IP is charged), ~$35–50 a month at 10,000 daily users.

### Build plan

1. **Firestore for server data.** Move `DeviceStore` (`src/store.ts`), and the metrics timelines, from JSON files to Firestore, so a node holds nothing durable. Choices to settle with Steve first:
   - **Firestore location:** it can't be changed later. `us-central1` is next to the relay and cheapest; `nam5` is multi-region.
   - **Client library:** the official `@google-cloud/firestore` package, or the REST API with a token from the VM's metadata server (keeps the server dependency-free).
   - **Local and test runs:** keep the JSON store behind the same interface, or use the Firestore emulator.
   The VM needs a service account with `roles/datastore.user`.
2. **Relay container image.** Node 24 plus TLS: Caddy alongside Node, or Node's own `https`. Keep the Let's Encrypt certificates across VM replacements (a small persistent disk, or Cloud Storage), or Let's Encrypt rate limits will bite. Store the image in Artifact Registry in the same project.
3. **Managed instance group** (scripts in `deploy/gcp`, next to the current ones):
   - Container-Optimized OS, with the container started by cloud-init. The older "container declaration" way of running containers on COS VMs may be deprecated; check the current docs before using it.
   - A **stateful** group, so each node keeps its static Standard-tier IP and disk across replacements. The first node, `relay-1`, should take over the current static IP `walkie-relay-ip` (`35.209.96.216`), so existing DNS keeps working. That means a short cut-over: release the IP from `walkie-relay`, then assign it to the group.
   - A health check on `/healthz` with autohealing, and rolling replacement for deploys (drain first).
   - An uptime check with an email alert to Steve.
   - Serve both `relay-1.overandout.app` and `walkie.cypressoakstudios.com` during the transition; the current app builds use the latter.
   - DNS: Steve adds `A relay-1 → 35.209.96.216` at GoDaddy (overandout.app's DNS is at GoDaddy, nameservers `ns61/ns62.domaincontrol.com`). As of 2026-09-26 **it isn't added yet**; check with `dig +short relay-1.overandout.app`.
   - Retire the hand-built `walkie-relay` VM once `relay-1` works.
4. **Relay protocol:**
   - the node's hostname in the ring payload;
   - a "delivered" message to the sender once the recipient has heard a burst;
   - accept a re-sent burst with the same `burstId` without playing it twice.
5. **Apps:**
   - the rendezvous-hash node choice, with shared test vectors for TypeScript and Swift;
   - the sender keeps unheard bursts and re-sends them after a failover, and runs its own 35 s ring timeout;
   - fail over to the next node when a node is unreachable;
   - follow a new ring for the same person without ringing again.
6. **Two-node test:** stop a node mid-ring and mid-conversation, and check that the message still arrives and both apps meet on the next node.

Sign-in tokens (signed by the API, checked on each node with a public key) come with the accounts work: Sign in with Apple, invites, friends, blocks, report and account deletion.

## Open risks

- **Tapping the notification still takes ~3.2 s** to first audio. The app isn't running when the ring arrives, so it can't pre-connect as the in-app ring does. Ideas: open a stream when watchOS launches the app early (it did in run 16, not in run 20), or a Notification Service Extension on watchOS (availability unverified).
- **Fallbacks haven't run on a device:** rejoining on a fresh stream after a failed or stale one.
- **watchOS 9–11 is untested:** whether the Opus encoder exists there (`VoiceEncoder` silently falls back to 256 kbps PCM), and background behaviour.
- **App Review:** see the doc's "App Store, privacy and business" section.

## Deployment today (Google Cloud)

- **Resources:**
  - project `walkie-talkie-relay` (owned by stevelt@gmail.com);
  - VM `walkie-relay` (e2-micro, Debian 13, us-central1-a);
  - static IP `walkie-relay-ip` `35.209.96.216` (Standard tier);
  - firewall rule `walkie-web` (80/443).
- **DNS:** `walkie.cypressoakstudios.com` → `35.209.96.216`, an A record at GoDaddy.
- **Stack:** Caddy (Let's Encrypt, HTTP/2, `flush_interval -1`) in front of Node on 127.0.0.1:8080, as the systemd service `walkie`. Releases are under `/opt/walkie/releases/`.
- **Deploy:** commit, then run `deploy/gcp/deploy.sh`, which ships **committed** code only and copies the APNs key. `gcloud` is at `~/google-cloud-sdk/bin`, which isn't on the agent shell's PATH, so prefix `export PATH=$HOME/google-cloud-sdk/bin:$PATH`. Running now: `fca101f`.
- **Logs:**

  ```bash
  gcloud compute ssh walkie-relay --zone=us-central1-a --project=walkie-talkie-relay -- sudo journalctl -u walkie -n 100
  ```
- **Registered users:**
  - `watch-0d34`: the product app on Steve's watch, with a real APNs sandbox token;
  - `watch-abee`: the spike on Steve's watch;
  - `bot`: "Test Bot";
  - the test users `smoke-listener`, `smoke-sender` and `smoke-http`.

  There's no delete endpoint. The server reads the old `voipToken` field in `devices.json` as `pushToken`.
- **Project list lag:** the project may not show in `gcloud projects list`, but it works by ID.

## Local config (gitignored; don't commit or print)

- `deploy/gcp/config.sh`: `PROJECT_ID`, `DOMAIN`, the relay's shared `SPIKE_TOKEN`, and the `APNS_*` settings. `APNS_BUNDLE_ID` is the watch app's ID, `com.cypressoakstudios.overandout.watchkitapp`, because the watch registers for pushes itself.
- `app/Config/Local.xcconfig`: the paid `DEVELOPMENT_TEAM`, and `OAO_SERVER_TOKEN` (the same shared token).
- `watch/Config/Local.xcconfig`: the spike's settings (Personal Team). The spike is kept for reference only.
- To use the token in commands without printing it:

  ```bash
  grep -o 'SPIKE_TOKEN="[^"]*"' deploy/gcp/config.sh | cut -d'"' -f2
  ```

## Testing on the watch

- **Hardware:** Steve's watch, on watchOS 27 (UDID `00008320-0013043A1E60000A`), paired with an iPhone. The product app is `watch-0d34`, with Test Bot picked as the friend. Over&Out is on the allowed apps of Steve's Do Not Disturb Focus.
- **Install:** Steve runs the **OverAndOutWatch** scheme from Xcode, then clicks **Stop**, so there's no debugger during measurements.
- **Ring it with the bot**, from `server/`, in the background:

  ```bash
  SPIKE_SERVER=https://walkie.cypressoakstudios.com SPIKE_TOKEN=… node tools/bot.ts send --to watch-0d34 --name "Test Bot" --say "…" --ring-until-answered --stay 30
  ```

  `--again N` sends a second message N s after the watch joins.
- **Timeline:** `node tools/report.ts <conversationId>` (same env vars). The watch uploads its timeline when the conversation ends, so ask Steve to tap **End**.
- **Cold start:** Settings → Testing → **Quit when I leave** (debug builds), then press the crown. watchOS 27 has no app switcher, and quitting in the foreground brings the app back.

## Simulator

A local relay started with `SIMULATOR_PUSH=1` delivers rings to the watch simulator with `xcrun simctl push`, so the ring → notification → tap → join path runs locally.

```bash
cd server && PORT=8080 DATA_DIR=<dir> SPIKE_TOKEN=simtoken SIMULATOR_PUSH=1 node src/main.ts
```

```bash
cd app && xcodebuild -project OverAndOut.xcodeproj -scheme OverAndOutWatch -destination 'id=5DE92663-5226-41E6-9799-2C68705F50F7' -derivedDataPath <dir> OAO_SERVER_HOST=localhost:8080 OAO_SERVER_TOKEN=simtoken DEVELOPMENT_TEAM= OAO_PUSH=no OAO_BUNDLE_ID=com.cypressoakstudios.overandout.dev build
```

Then:
1. Install `OverAndOutWatch.app` with `xcrun simctl install`, and launch `com.cypressoakstudios.overandout.dev.watchkitapp`.
2. Ring it with the bot, as the simulator's user `watch-7743`.

Details:
- The Apple Watch Series 12 (46mm) simulator is `5DE92663-5226-41E6-9799-2C68705F50F7`. It has no microphone, so it sends a 440 Hz test tone.
- The Claude Code iOS Simulator tool can tap and hold on the watch simulator (`touch_path` for Talk).
- The server host and token are read from the build on every launch.

## Gotchas

- **Never measure timing under Xcode's debugger.** Over the watch's wireless link it stops the whole app for 1–20 s whenever a system library loads.
- **Xcode can't always reach the watch** (`CoreDeviceError 4000`). Wake and unlock the watch and the iPhone, and put them on the same Wi-Fi as the Mac. Don't run `devicectl` while Steve is using Xcode.
- **Node strips TypeScript types but doesn't transform them:** constructor parameter properties (`constructor(private x)`) fail at runtime. Use plain fields.
- **Simulator builds need their ad-hoc signature** (don't pass `CODE_SIGNING_ALLOWED=NO`). For device compile checks, it's fine.
- **No `timeout` on macOS:** use `perl -e 'alarm N; exec @ARGV'`.
- **Stage files by name,** never `git add -A`.

## Steve's preferences

- **Hosting:** Google Cloud only, among AWS, Azure and Google Cloud. No Cloudflare or other new providers. No manual VM or OS patching.
- **Git:** commit or push only when asked. Committing locally in order to deploy is fine.
- **Doc:** record design decisions and measured results in the feasibility doc.
- **Secrets:** never print the relay token or APNs keys.
