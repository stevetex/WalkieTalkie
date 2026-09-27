# Handoff: Over&Out — option E relay infrastructure (2026-09-26)

Read this first. Over&Out: Watch Walkie Talkie replaces Apple's Watch Walkie-Talkie app, which Apple removed in watchOS 27. The watch app works end to end on Steve's watch with real APNs pushes. Option E's infrastructure (steps 1–3 below) is built: the relay now runs as `relay-1` in a managed instance group on Container-Optimized OS, with its data in Firestore. The next job is steps 4–6: the relay protocol, the apps' node choice and failover, and a two-node test. There are no secrets in this file. Tokens and keys live in gitignored files and Secret Manager, listed under Local config.

## Start here

1. Read this file, then the feasibility doc: its **Hosting** section (option E and the options it beat), **Design decisions** (especially the 2026-09-26 rows), and **Prototype results** runs 16–32. Then [deploy/gcp/README.md](deploy/gcp/README.md) for how relay nodes are set up and deployed.
2. Check "Left over from steps 1–3" below, starting with tap → first audio through `relay-1` (runs 24–30).
3. Do **option E steps 4–6**: relay protocol, apps, two-node test.
4. Ask Steve before anything outward-facing or billed: creating Google Cloud resources, deploying to the live relay, DNS changes (he adds GoDaddy records by hand), and deleting VMs or data.

## Links

- **Feasibility doc (Claude Docs):** https://claude.ai/code/artifact/59ab6e47-6e5d-4698-8bd1-173293953df9. Log design decisions in its Design decisions table (date, decision, why, revisit if), and measured results in Prototype results.
- **Repo:** https://github.com/stevetex/WalkieTalkie. The option E work is committed locally on `main` (deploys build committed code); push only when Steve asks.
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
  - Node 24+, TypeScript run directly, no dependencies; `npm test` runs 39 tests (4 of them skip without the Firestore emulator; `npm run test:firestore` runs those against it).
  - Stores (`src/store.ts`) are async interfaces: JSON files locally and in tests, Firestore (`src/firestore.ts`, REST) on nodes (`STORE=firestore`). Metrics timelines are buffered per conversation and written as one document when it goes quiet.
  - On nodes it reads the relay token and APNs key from Secret Manager (`src/secrets.ts`), drains open conversations for up to 45 s on SIGTERM, and reports its revision in `/healthz`.
  - It sends time-sensitive **alert** pushes (`ringAlert()` in `src/apns.ts`) to the watch app's topic. There are no VoIP pushes any more.
  - `SIMULATOR_PUSH=1` delivers rings to simulators with `xcrun simctl push` (development only).
  - Deployed: `ddc6849` on `relay-1` (see Deployment today).
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

1. **Firestore for server data.** Done. Firestore (default) database in `us-central1`, Standard edition, delete protection on; the relay talks to it over REST with the metadata-server token; JSON store for local runs and tests; one metrics document per conversation per writer, with a 30-day TTL. The old VM's devices and 882 metric events were imported (`server/tools/import-data.ts`).
2. **Relay container image.** Done. `server/Dockerfile`: Node 24 and Caddy in one container, built by Cloud Build (`deploy/gcp/build-image.sh`) into Artifact Registry `relay`. Certificates live on each node's stateful data disk. HTTP/3 is off.
3. **Managed instance group.** Done. Stateful group `relay` (us-central1-a) on COS via cloud-init (`deploy/gcp/relay-node.cloud-init.yaml`); `relay-1` has the static IP `walkie-relay-ip` (`35.209.96.216`) and serves `relay-1.overandout.app` and `walkie.cypressoakstudios.com`; health check `relay-health` with autohealing; rolling deploys with drain (`deploy-relay.sh`); uptime checks with email alerts to steve@stevetex.com for both names (`setup-uptime.sh`). The cut-over on 2026-09-26 left the relay down for at most 84 s.

#### Left over from steps 1–3

- **Tap → first audio and the TLS certificate:** through `relay-1` with Let's Encrypt it was 3.8–4.2 s (runs 24, 26, 27), against 2.9–3.4 s on the old VM. A packet capture on `relay-1` (run 27) showed the watch spending ~1.0 s evaluating the certificate chain on every new connection: Let's Encrypt's YE2 chains to ISRG Root YE, which isn't in Apple's trust store. `relay-1` now gets certificates from **Google Trust Services** (Google Cloud's free Public CA; `acme-eab` secret, see `server/container/entrypoint.sh`). Runs 28–30: tap → first audio median 3.12 s (2.43–3.66 s), against a median of 4.13 s over five rings with Let's Encrypt, so the regression is recovered. The capture in run 28 showed certificate evaluation at 0.76 s on the first connection after a tap (~1.0 s before) and 0.31 s on later ones (0.87 s before); the remaining first-connection cost looks like a cold start on the watch. The rest of the spread is the watch's network wake-up, which varies ring to ring. To capture again: `toolbox` on the node has `tcpdump` (reinstalled after each node replacement, ~5 min). The in-app ring (run 25) was 1.50 s, against 0.95 s in run 22. Recording `URLSessionTaskMetrics` on the watch didn't work: it never delivered metrics for the cancelled stream.
- **Each new node needs a fresh Public CA key** before it's added: `gcloud publicca external-account-keys create --format=json | gcloud secrets versions add acme-eab --data-file=-` (a key registers one ACME account; Caddy keeps the account on the node's disk).
- **The watch app now connects to `relay-1.overandout.app`** (`OAO_SERVER_HOST` in `app/Config/Base.xcconfig`, changed 2026-09-26). `relay-1` still serves `walkie.cypressoakstudios.com` for older builds. Once none are left, drop that name from `relay-1`'s `relay-hostnames` metadata and its uptime check; Steve can then delete the GoDaddy record.
- The hand-built `walkie-relay` VM and its scripts (`create-vm.sh`, `deploy.sh`, `provision.sh`) were deleted on 2026-09-26, after its data was imported into Firestore. There's no rollback to it; roll back by deploying an earlier commit.
- **OS updates without deploys:** nodes get the newest COS whenever they're replaced, so a quiet month with no deploys means no OS update. A scheduled monthly replacement (for example, Cloud Scheduler calling the group's rolling replace) isn't set up yet.
- **Cloud Build runs as the Compute Engine default service account,** which has Editor. A dedicated build service account with only Artifact Registry write would be tighter.

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

- **Prefetch prototype (built 2026-09-27; keep, refine or back out):** tapping the notification took 2.4–3.7 s to first audio, mostly the watch's network waking for the first request after the tap. Now the relay sends a second, silent push with the same collapse ID 3 s after an APNs ring, or when the sender's first burst ends (`prefetchAlert`, `PREFETCH_PUSH_MS`; `deploy-relay.sh` sets 3000, 0 turns it off). The watch's notification service extension (`app/WatchNotificationService`) downloads the held message from `GET /v1/rings/audio` into the app group `group.<bundle ID>`. On a tap the app plays it before the relay stream opens (`Watch/Prefetch.swift`, `ConversationController.playPrefetched`) and skips those frames in the replay. Run 32: tap → first audio **0.77 s**; the download finished 13 s before the tap. Open questions:
  - whether the second push buzzes the wrist again;
  - what remains: mostly the audio session starting (0.49 s), which could start as soon as the app opens from the notification;
  - a tap within ~3 s of the ring takes the old path;
  - the simulator never runs the extension for `simctl push`, so test it on the watch.
- **Fallbacks haven't run on a device:** rejoining on a fresh stream after a failed or stale one.
- **watchOS 9–11 is untested:** whether the Opus encoder exists there (`VoiceEncoder` silently falls back to 256 kbps PCM), and background behaviour.
- **App Review:** see the doc's "App Store, privacy and business" section.

## Deployment today (Google Cloud)

- **Resources** (project `walkie-talkie-relay`, owned by stevelt@gmail.com; all in us-central1):
  - instance group `relay` (zone us-central1-a) with one node, `relay-1` (e2-micro, COS, 10 GB boot disk, 10 GB data disk `relay-1-1`), template `relay-<commit>`;
  - static IP `walkie-relay-ip` `35.209.96.216` (Standard tier), now on `relay-1`;
  - Firestore (default) database; service account `relay-node` (Firestore, logs, metrics, image pull, the two secrets);
  - Artifact Registry repo `relay`; Secret Manager secrets `relay-token`, `apns-key` and `acme-eab` (the Public CA account key);
  - health check `relay-health`, firewall rule `walkie-web` (80/443), two uptime checks and alert policies.
- **DNS** (A records at GoDaddy): `relay-1.overandout.app` and `walkie.cypressoakstudios.com` → `35.209.96.216`.
- **Deploy:** commit, then `deploy/gcp/deploy-relay.sh`. It builds the committed code, then replaces `relay-1` (about 2 minutes of downtime with one node). `gcloud` is at `~/google-cloud-sdk/bin`, which isn't on the agent shell's PATH, so prefix `export PATH=$HOME/google-cloud-sdk/bin:$PATH`. Running now: `ddc6849`.
- **Logs:**

  ```bash
  gcloud compute ssh relay-1 --zone=us-central1-a --project=walkie-talkie-relay -- sudo journalctl -u relay -n 100
  ```

  After a node is replaced, SSH refuses its new host key; see the README's Everyday commands.
- **Registered users** (in Firestore `devices`):
  - `watch-0d34`: the product app on Steve's watch, with a real APNs sandbox token;
  - `watch-abee`: the spike on Steve's watch;
  - `bot`: "Test Bot";
  - the test users `smoke-listener`, `smoke-sender` and `smoke-http`.

  There's no delete endpoint. Firestore document IDs can't contain `/`, so user IDs can't either.
- **Project list lag:** the project may not show in `gcloud projects list`, but it works by ID.

## Local config (gitignored; don't commit or print)

- `deploy/gcp/config.sh`: `PROJECT_ID`, `DOMAIN`, the relay's shared `SPIKE_TOKEN`, the `APNS_*` settings, and `ALERT_EMAIL`. `APNS_BUNDLE_ID` is the watch app's ID, `com.cypressoakstudios.overandout.watchkitapp`, because the watch registers for pushes itself.
- **Secret Manager** holds the node copies: `relay-token` (the same `SPIKE_TOKEN`) and `apns-key` (the .p8), created by `setup-relay.sh`. To rotate one, add a new version (`gcloud secrets versions add … --data-file=-`) and redeploy.
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
  SPIKE_SERVER=https://relay-1.overandout.app SPIKE_TOKEN=… node tools/bot.ts send --to watch-0d34 --name "Test Bot" --say "…" --ring-until-answered --stay 30
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
- **COS's host firewall drops incoming TCP except SSH.** The node's cloud-init opens 80 and 443; without that, health checks fail and autohealing recreates the node every 5 minutes.
- **A newly enabled Google API can refuse calls for a minute or two** (Cloud Build said PERMISSION_DENIED to the project owner right after being enabled).
- **The Firestore emulator needs Java 21+.** `brew install openjdk` (keg-only) is installed, and `npm run test:firestore` uses it.
- **`zsh` doesn't split unquoted variables,** so `gcloud … $FLAGS` passes one argument. Spell flags out, or run the command under `bash`.

## Steve's preferences

- **Hosting:** Google Cloud only, among AWS, Azure and Google Cloud. No Cloudflare or other new providers. No manual VM or OS patching.
- **Git:** commit or push only when asked. Committing locally in order to deploy is fine.
- **Doc:** record design decisions and measured results in the feasibility doc.
- **Secrets:** never print the relay token or APNs keys.
