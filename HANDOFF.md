# Handoff: Over&Out — the iPhone talks too (2026-09-28)

Read this first. Over&Out: Watch Walkie Talkie replaces Apple's Watch Walkie-Talkie app, which Apple removed in watchOS 27. The watch app works end to end on Steve's watch with real APNs pushes, through relay nodes on Google Cloud: a ring's message plays about **0.5–0.8 s after the tap** (runs 36–48) and 0.3 s after an in-app answer (run 42). Accounts, the iPhone app, profile photos and the branding are built and live. **New on 2026-09-28: the iPhone talks too** (iPhone ↔ watch and iPhone ↔ iPhone) through Apple's PushToTalk framework: on Steve's locked iPhone a friend's message plays with no tap, **1.2–1.5 s after the push is sent** (runs 45, 47), and he replies from the Lock Screen. It's on the `iphone-talk` branch, committed locally, not pushed; the relay and API it needs are deployed. There are no secrets in this file. Tokens and keys live in gitignored files and Secret Manager, listed under Local config.

## Start here

1. Read this file, then the feasibility doc's **Design decisions** (the five 2026-09-27 iPhone-talk rows and the 2026-09-28 PushToTalk requirements row) and **Prototype results** runs 44–48.
2. Ask Steve whether to push `iphone-talk` and open a PR (nothing is pushed yet), then do the **Next job** below.
3. Ask Steve before anything outward-facing or billed: creating Google Cloud resources, deploying to the live relay or the API, DNS changes (he adds GoDaddy records by hand), App Store Connect or developer-portal changes Xcode doesn't make itself (for example a new capability or push certificate), and deleting VMs or data.

## Links

- **Feasibility doc (Claude Docs):** https://claude.ai/code/artifact/59ab6e47-6e5d-4698-8bd1-173293953df9. Log design decisions in its Design decisions table (date, decision, why, revisit if), and measured results in Prototype results (runs 1–50 so far).
- **Backlog (Claude Docs):** https://claude.ai/code/artifact/30273f1c-2795-4fd7-b15a-370b1a177118. Small follow-ups with a Status column. New on 2026-09-28: eleven iPhone-talk items (testing PushToTalk with production push, warming the iPhone's relay connection, sharing the conversation core with the watch, and more). Older open items include retiring the shared relay token, blocks ending an open conversation, the API accepting tokens of ended sessions, a device's registration under a previous account, invites across the App Store install, session key rotation, reviewing reports, and the invite sheet's double lookup.
- **Repo:** https://github.com/stevetex/WalkieTalkie. `main` has accounts (`665153a`, `c22cbc2`, `8537f6c`), branding (PR #1) and the device-test fixes and mascot watch screen (PR #2, `8037234`, `ba813ab`). photos, About and "Screen name" (PR #3, `3880fac`). **`iphone-talk`** (local, not pushed): `adf12b9` (the relay, API and iPhone talk), then device fixes `fa3b44d`, `6b88915`, `4f21ec9`, `c063527`, `ee6f3ad`, `11cb2eb`, `e37b124`, `c53578d`, `cedc40e`, `7d7b300`.
- **App name and domain:** "Over&Out: Watch Walkie Talkie", overandout.app (DNS at GoDaddy, nameservers `ns61/ns62.domaincontrol.com`). Bundle IDs `com.cypressoakstudios.overandout` (iPhone), `…overandout.watchkitapp` (watch) and `…overandout.watchkitapp.notificationservice`. Team `A39XNKNDPX`.

## Next job: finish iPhone talk, then the MVP list

iPhone talk works on Steve's devices (runs 45–48). Before the Beta:
1. **Push and PR** `iphone-talk` when Steve says so.
2. **Test PushToTalk with production push** (backlog): development builds get pushes through the APNs sandbox, whose connection on the phone can die unnoticed. Pushes were then accepted (200) and silently dropped until Airplane Mode was toggled (see Gotchas). Apple DTS advises testing PushToTalk with production push, which means a TestFlight build: an App Store Connect upload, so ask Steve first.
3. **The iPhone-talk backlog items**, especially warming the relay connection (the cold connection is ~0.95 s of the 1.2–1.5 s), the stale watch registration that can take an iPhone's rings, and sharing the conversation core and mascot with the watch.
4. **Still to do for the MVP:** the App Store listing (screenshots, description, privacy label: identifiers, name, usage data, and User Content → Photos or Videos for profile photos; review notes should explain PushToTalk and the audio background mode), the website in the new branding (`web/public`), retiring the shared relay token (backlog), and the watchOS 9–11 checks (backlog).

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
  - **Relay:** accepts session tokens (user and device from the token) and the shared token (user ID from the request, never an account's). An account can only ring a friend (`ringLookup`, one Firestore batch read per ring); one kind of device rings (see Done on 2026-09-28); otherwise `talk-refused`. Diagnostics and `POST /v1/devices` are shared-token only.
  - **Tests:** `npm test` runs 73 (17 skip without the emulator); `npm run test:firestore` runs 17, including the whole account suite against the Firestore emulator. `swift test` in the kit runs 21.
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

### Measured on Steve's iPhone (no debugger, PushToTalk, sandbox APNs)

| What | Result |
| --- | --- |
| Push sent → PushToTalk push received | 0.19–0.35 s (runs 45, 47) |
| Push received → audio session active | 0.46–0.65 s |
| Push received → relay stream joined | 0.97–1.18 s (the cold connection is the longest step) |
| **Push sent → first audio (no tap)** | **1.16 s** (run 45); 1.54 s over a Bluetooth headset (run 47) |
| Lock Screen Talk → first frame sent / relay's go-ahead | 1.14 s / 1.28 s (run 47) |

## Open risks

- **WatchConnectivity handoff** worked once on hardware (run 36). If it proves unreliable, the fallbacks are the watch asking again on reachability changes (already there), Settings → "Sign In on Watch Again" on the iPhone, or Sign in with Apple on the watch.
- **App Review:** report/block and account deletion are in; the listing, privacy label and review notes aren't written yet.
- **watchOS 9–11 is untested** (Opus encoder, background behaviour, the extension). In the backlog, needed before the Beta.
- **PushToTalk on production push is unmeasured.** Every iPhone run used the APNs sandbox, which silently dropped pushes until Airplane Mode was toggled. Production should be steadier (Apple DTS), but it needs a TestFlight build to confirm (backlog).
- **App Review and the audio background mode:** the iPhone declares `audio` alongside `push-to-talk` because PushToTalk can't activate its audio in the background without it. It's ordinary playback (guideline 2.5.4); explain it in the review notes.
- **One relay node:** a deploy or a node failure means about 2 minutes without the relay until option E's failover and a second node exist.

## Deployment today (Google Cloud)

- **Resources** (project `walkie-talkie-relay`, owned by stevelt@gmail.com; all in us-central1):
  - instance group `relay` (zone us-central1-a) with one node, `relay-1` (e2-micro, COS, 10 GB boot disk, 10 GB data disk `relay-1-1`), template `relay-<commit>`, **running `b0e9e18`** (UI polish: records "last messaged you"; deployed by Steve 2026-09-28);
  - static IP `walkie-relay-ip` `35.209.96.216` (Standard tier), on `relay-1`;
  - Firestore (default) database, TTL policies on `timelines.expireAt` and `invites.expireAt`;
  - service accounts `relay-node` (Firestore, logs, metrics, image pull, its secrets) and `account-api` (Firestore, the API's secrets);
  - Cloud Run service `api` (`https://api-yqgprbu3ja-uc.a.run.app`, scales to zero, max 4 instances, running `b0e9e18`);
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

## Testing on the iPhone

- **Hardware:** Steve's iPhone 17 Pro Max ("Tex iPhone 17", UDID `00008150-000215EA3E02401C`), iOS 27. Install as for the watch: the **OverAndOut** scheme, then **Stop**. After a reinstall, check Settings → Walkie-Talkie: it can leave the channel (backlog), and then rings go to the watch.
- **Ring it with the bot:** set Ring Me On to iPhone, lock the phone, then `bot.ts send --account` as above. The message plays with no tap; `--stay 60` leaves time to reply from the Lock Screen's Talk button (tap the blue waveform in the Dynamic Island). The iPhone uploads its timeline when it leaves the conversation, which it does by itself once the audio stops.
- **If nothing plays** and the timeline has no `pttPushReceived`, toggle Airplane Mode on the iPhone (the sandbox push connection; see Gotchas), then ring again.
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

## Steve's preferences

- **Hosting:** Google Cloud only, among AWS, Azure and Google Cloud. No Cloudflare or other new providers. No manual VM or OS patching.
- **Git:** commit or push only when asked. Committing locally in order to deploy is fine.
- **Doc:** record design decisions and measured results in the feasibility doc; small non-blocking follow-ups go in the backlog doc.
- **Secrets:** never print the relay token, APNs keys, signing keys or a built app's Info.plist.
- **DNS:** Steve adds GoDaddy records himself; give him the exact records.
