# Handoff: Over&Out — accounts, branding and device tests done; UX tweaks under way (2026-09-27)

Read this first. Over&Out: Watch Walkie Talkie replaces Apple's Watch Walkie-Talkie app, which Apple removed in watchOS 27. The watch app works end to end on Steve's watch with real APNs pushes, through relay nodes on Google Cloud, with a prototype that plays a ring's message about 0.7 s after the tap. **Accounts and the iPhone companion app are now built** (Sign in with Apple, friends, invites, block and report, account deletion), the account API and overandout.app are live, and the relay accepts session tokens. On Steve's devices, sign-in on the iPhone and watch, an invite to the Test Bot and a ring both ways all worked, with **tap → first audio 0.48 s** (run 36). The app icon, wordmark and palette are in both apps (`0e65ca9`, merged as `99469d8`). The three remaining device tests passed (runs 37–40), and Steve is now tweaking the user experience, starting with the watch screen. There are no secrets in this file. Tokens and keys live in gitignored files and Secret Manager, listed under Local config.

## Start here

1. Read this file, then the feasibility doc's **Design decisions** (the six 2026-09-27 rows: the account API, the watch's identity, session tokens, overandout.app hosting, the Firestore model and invites, and two-account testing) and **Hosting → Accounts and overandout.app**.
2. Continue the **UX tweaks** below with Steve.
3. Ask Steve before anything outward-facing or billed: creating Google Cloud resources, deploying to the live relay, DNS changes (he adds GoDaddy records by hand), App Store Connect or developer-portal changes Xcode doesn't make itself, and deleting VMs or data.

## Links

- **Feasibility doc (Claude Docs):** https://claude.ai/code/artifact/59ab6e47-6e5d-4698-8bd1-173293953df9. Log design decisions in its Design decisions table (date, decision, why, revisit if), and measured results in Prototype results (runs 1–40 so far).
- **Backlog (Claude Docs):** https://claude.ai/code/artifact/30273f1c-2795-4fd7-b15a-370b1a177118. Small follow-ups with a Status column. New on 2026-09-27: retiring the shared relay token, blocks ending an open conversation, a device's registration under a previous account, invites across the App Store install, session key rotation, and reviewing reports.
- **Repo:** https://github.com/stevetex/WalkieTalkie. `main` is pushed (accounts: `665153a`, `c22cbc2`, `8537f6c`; branding: `0e65ca9`, merged in `99469d8`).
- **App name and domain:** "Over&Out: Watch Walkie Talkie", overandout.app (DNS at GoDaddy, nameservers `ns61/ns62.domaincontrol.com`). Bundle IDs `com.cypressoakstudios.overandout` (iPhone), `…overandout.watchkitapp` (watch) and `…overandout.watchkitapp.notificationservice`. Team `A39XNKNDPX`.

## Next job: UX tweaks (the three device tests are done)

**Done 2026-09-27 (runs 36–40):** sign-in, the watch over WatchConnectivity, the bot as a friend and rings both ways (run 36, tap → first audio 0.48 s); the invite link opening the app and the acceptance sheet (run 37); report and block, with the alert email, the report in Firestore and the refused ring (run 38); account deletion with Apple token revocation, and the watch signing out (run 39); a new account for Steve and a ring (run 40, 0.80 s). Fixed on the way: the iPhone masthead hid the Friends screen's navigation bar and Settings button (it's now inside the navigation stack); Settings' two confirmation dialogs opened from the same spot and Delete Account wasn't red, so the first delete signed out instead; deletion is now its own screen that explains Apple's "Sign in to Over&Out" confirmation and ends on "Your account is deleted" (design decision 2026-09-27). `node tools/test-account.ts invite` makes an invite from the bot.

### UX tweaks

First up (2026-09-27): the watch's main screen, with the mascot filling the screen, its mouth as the Talk button, on the indigo background, and no small wordmark in the corner. Steve describes further changes as he goes. Keep the branding (`OverAndOutKit/Brand.swift` and each target's `Assets.xcassets`; source art in `art/`) and apply `.brandScreen()` to new screens. Check changes on the iPhone and watch simulators (see Simulator), then on Steve's devices without the debugger, and re-measure tap → first audio if the watch's ring or answer path changes.

**Still to do for the MVP:** the App Store listing (screenshots, description, privacy label: identifiers, name, usage data; the privacy policy is at overandout.app/privacy, support at /support), the website in the new branding (`web/public`), retiring the shared relay token (backlog), and the watchOS 9–11 checks (backlog).

## Where things stand

- **Accounts (2026-09-27):**
  - **API** (`server/src/api.ts`, `accounts.ts`, `session.ts`, `apple.ts`; `api-main.ts` for Cloud Run): Sign in with Apple with a nonce; Ed25519 JWT session tokens (30 days, refreshed when a day old, refreshable up to a year past expiry while the session exists); the iPhone mints the watch's session (`POST /v1/auth/device`); profile, friends, single-use 7-day invites, blocks, reports (logged as `[report]`, emailed by an alert), push registration (`PUT /v1/me/device`), account deletion with Apple token revocation.
  - **Firestore model:** `users/{uid}` with `friends`, `blocks`, `devices` and `sessions` subcollections; `appleSubs/{sub}`; `invites/{code}` (TTL on `expireAt`); `reports/{id}`. The account logic runs on a small `Docs` interface: Firestore REST with atomic commits and preconditions, or `MemoryDocs` locally.
  - **Relay:** accepts session tokens (user ID from the token) and the shared token (user ID from the request, never an account's). An account can only ring a friend (`ringLookup`, one Firestore batch read per ring) and rings every watch on the account; otherwise `talk-refused`. Diagnostics and `POST /v1/devices` are shared-token only.
  - **Tests:** `npm test` runs 67 (4 skip without the emulator); `npm run test:firestore` runs 16, including the whole account suite against the Firestore emulator. `swift test` in the kit runs 19.
- **iPhone app (`app/iOS`):** sign-in, onboarding (name, Focus step, watch), friends list, invite via the share sheet, invite acceptance sheet (universal links), friend page (report with reasons and optional block, block, remove), settings (name, watch status and re-send sign-in, Focus help, blocked people, privacy and support links, sign out, delete account).
- **Branding (2026-09-27, `0e65ca9`):** the icon ("Chrome Tomorrow" mascot), the stacked wordmark and light/dark semantic colors are in each target's `Assets.xcassets`; `OverAndOutKit/Brand.swift` has the palette and `.brandScreen()`. The iPhone root has a masthead; the watch shows a small wordmark bottom right. Source art, exports and usage notes are in `art/` (see `art/README.md`). The website (`web/public`) doesn't use it yet.
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

## Open risks

- **WatchConnectivity handoff** worked once on hardware (run 36). If it proves unreliable, the fallbacks are the watch asking again on reachability changes (already there), Settings → "Sign In on Watch Again" on the iPhone, or Sign in with Apple on the watch.
- **App Review:** report/block and account deletion are in; the listing, privacy label and review notes aren't written yet.
- **watchOS 9–11 is untested** (Opus encoder, background behaviour, the extension). In the backlog, needed before the Beta.
- **One relay node:** a deploy or a node failure means about 2 minutes without the relay until option E's failover and a second node exist.

## Deployment today (Google Cloud)

- **Resources** (project `walkie-talkie-relay`, owned by stevelt@gmail.com; all in us-central1):
  - instance group `relay` (zone us-central1-a) with one node, `relay-1` (e2-micro, COS, 10 GB boot disk, 10 GB data disk `relay-1-1`), template `relay-<commit>`, **running `665153a`**;
  - static IP `walkie-relay-ip` `35.209.96.216` (Standard tier), on `relay-1`;
  - Firestore (default) database, TTL policies on `timelines.expireAt` and `invites.expireAt`;
  - service accounts `relay-node` (Firestore, logs, metrics, image pull, its secrets) and `account-api` (Firestore, the API's secrets);
  - Cloud Run service `api` (`https://api-yqgprbu3ja-uc.a.run.app`, scales to zero, max 4 instances, running `c22cbc2`);
  - Firebase added to the project (Steve accepted the terms in the console); Hosting site `walkie-talkie-relay` (`walkie-talkie-relay.web.app`) with the custom domain overandout.app; `/v1/*` rewritten to `api`;
  - Artifact Registry repo `relay` (images `relay` and `api`); Secret Manager secrets `relay-token`, `apns-key`, `acme-eab`, `session-signing-key`, `session-public-keys` (key ID `k20260927`) and `apple-siwa-key`;
  - health check `relay-health`, firewall rule `walkie-web` (80/443), two uptime checks and alert policies, and the alert policy "Over&Out: user report".
- **DNS** at GoDaddy: `relay-1.overandout.app` and `walkie.cypressoakstudios.com` A → `35.209.96.216`; `overandout.app` A → `199.36.158.100` and TXT `hosting-site=walkie-talkie-relay` (Firebase Hosting; the parked A record was replaced on 2026-09-27); `www` is a CNAME to the root (not served by Firebase yet).
- **Deploy:** commit, then `deploy/gcp/deploy-relay.sh` (about 2 minutes of downtime with one node), `deploy/gcp/deploy-api.sh` and `deploy/gcp/deploy-web.sh`. `gcloud` is at `~/google-cloud-sdk/bin`, which isn't on the agent shell's PATH, so prefix `export PATH=$HOME/google-cloud-sdk/bin:$PATH`.
- **Logs:**

  ```bash
  gcloud compute ssh relay-1 --zone=us-central1-a --project=walkie-talkie-relay -- sudo journalctl -u relay -n 100
  ```

  ```bash
  gcloud logging read 'resource.labels.service_name="api"' --project=walkie-talkie-relay --limit=50
  ```

  After a node is replaced, SSH refuses its new host key; see the deploy README's Everyday commands.
- **Data:** accounts in Firestore: Steve (`u_lddgnN9Qtcspo663` since 2026-09-27 run 40; the earlier `u_gNuPMeGUZQe1GC5A` was deleted in run 39) and the Test Bot (`u_NvlyGM47nb3JKca_`, Apple ID stand-in `test-bot.overandout`), who are friends. Legacy `devices`: `watch-0d34` (the product app on Steve's watch, old build), `watch-abee` (the spike), `bot`, and the test users `smoke-listener`, `smoke-sender` and `smoke-http`. Deleting them is in the backlog (with retiring the shared token).
- **Project list lag:** the project may not show in `gcloud projects list`, but it works by ID.

## Local config (gitignored; don't commit or print)

- `deploy/gcp/config.sh`: `PROJECT_ID`, `DOMAIN`, the relay's shared `SPIKE_TOKEN`, the `APNS_*` settings, `ALERT_EMAIL`, `SUPPORT_EMAIL` (support@cypressoakstudios.com, on the site's pages), and the Sign in with Apple key: `APPLE_SIWA_KEY_FILE` (`AuthKey_2SAVY539QZ.p8` in the repo root), `APPLE_SIWA_KEY_ID` and `APPLE_TEAM_ID`.
- **Secret Manager** holds the node and API copies (above). To rotate one, add a new version (`gcloud secrets versions add … --data-file=-`) and redeploy. The relay token was printed in a session transcript on 2026-09-26; retiring it is in the backlog.
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

## Steve's preferences

- **Hosting:** Google Cloud only, among AWS, Azure and Google Cloud. No Cloudflare or other new providers. No manual VM or OS patching.
- **Git:** commit or push only when asked. Committing locally in order to deploy is fine.
- **Doc:** record design decisions and measured results in the feasibility doc; small non-blocking follow-ups go in the backlog doc.
- **Secrets:** never print the relay token, APNs keys, signing keys or a built app's Info.plist.
- **DNS:** Steve adds GoDaddy records himself; give him the exact records.
