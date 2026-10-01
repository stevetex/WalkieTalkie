# Handoff: Over&Out — Roll Over to iPhone and resume after a dropped stream (PRs #37–#38, deployed; TestFlight build 165, 2026-10-01)

Read this first. Over&Out: Watch Walkie Talkie replaces Apple's Watch Walkie-Talkie app, which Apple removed in watchOS 27. The watch and iPhone apps work end to end through relay nodes on Google Cloud. **TestFlight build 0.1 (76)** (the Leave fix) is out to the internal group "House" (Steve, Helen, Cooper). **Beta telemetry's server side is live** (2026-09-29, by Steve's OK: the privacy policy, the API and the relay run `a85b15a` from branch `telemetry`; `setup-telemetry.sh` made the metrics, dashboard and alerts). The apps' side is TestFlight builds 79, 81, 84 and **0.1 (89)** (build 6, 2026-09-29: the watch rings first, the back-on banner, the frontmost-watch download); runs 56–63 on Steve's devices. **The newest is TestFlight build 102** (2026-09-30: the watch's friends list and per-friend Talk screens, the first press talking at once over a stream the Talk screen opens, network marks; runs 64–72). Usage analytics is live too (the spec's "Usage analytics"; `beta.ts usage`, `beta.ts stats`). On production push a locked iPhone plays a message 0.89–1.17 s after the push is sent (runs 53, 55), and a watch tap plays it in 0.67 s (run 51). There are no secrets in this file; tokens and keys live in gitignored files, Secret Manager and `~/.appstoreconnect`, listed under Local config.

## Start here

TestFlight email note (2026-09-30): Steve wants internal testers in "House" to receive every build without an email for each one. The group and `asc.ts release` are set to give them every build. Apple's `BuildBetaDetail.autoNotifyEnabled` applies to external groups, not this internal group's emails. Steve reports that disabling email in TestFlight did not stop them. No App Store Connect or upload-script change was made. A mailbox rule per tester, matching only this app's new-build messages, is the practical fallback. Live App Store Connect state could not be read because the local API request could not resolve `api.appstoreconnect.apple.com`.

Community follow-up: no confirmed fix found that silences internal-tester email while retaining every build. [John Voorhees's firsthand report](https://www.macstories.net/stories/testfights-inability-to-handle-large-beta-collections-needs-to-be-fixed/) describes email returning after disabling it and using a Gmail rule. A [February 2026 Reddit discussion](https://www.reddit.com/r/iOSProgramming/comments/1r69x5c/publishing_testflight_builds_without_notifying/) claims silent builds remain accessible but reports loss of auto-updates; the original suggestion is deleted and tester type is unclear, so it is not a verified solution for House. Older App Status Reports advice concerns account/status mail and has mixed success reports; do not assume it fixes "available to test" mail.

00. **Deployed (2026-10-01 evening, Steve's OK): the relay and the API run `b96bbd1` (PRs #37 and #38); TestFlight build 0.1 (165) from `b96bbd1` is in "House".** Next: re-run **103** (watch, app closed, a ~30 s message tapped ~10 s in: the whole message should play) and **106** (iPhone in the app, 20 s of airplane mode mid-message: "Reconnecting…", then the rest of the message). Ring Me On is iPhone for 106, Apple Watch otherwise. Runs 100–106 and what they found: "Done on 2026-10-01 (evening): build 160" below.
0. **Roll Over to iPhone (PR #38, deployed, build 165): works on Steve's devices.** Run 107 (watch ignored): rolled over 12.001 s after the watch's push; iPhone push → first audio 1.04 s (runs 90–95 median 1.14 s). Run 108 (Decline on the watch's in-app ring): the relay got declineReported 2.8 s after the tap, no rollover, the iPhone stayed quiet. Steve: one way only for now (iPhone → watch is a backlog row). Feasibility doc rows 107 and 108; backlog: a follow-up on the decline's 2.8 s and a double audioPrefetched after it.
0. **Fixed (2026-10-01, build 143 = `main` after PR #29): watch messages are audible.** They had always been silent: the watch's microphone gives 3 discrete channels and `AVAudioConverter` from 3 to mono output zeros. Now the loudest channel is sent with automatic gain (to about −20 dBFS, at most +36 dB). Build 143: sent −24 dBFS RMS, gain at its 36 dB ceiling, Steve heard the Test Bot's echo, and watch-to-watch with Helen works. Feasibility doc: a Prototype results row and a Design decisions row. Still open: the phone-call test of #23/#27 (Ring Me On iPhone first), and the iPhone's −52 dBFS send over a Bluetooth headset (54fbb9da…).
1. Read this file, the **Over&Out Beta telemetry spec** (Links), then the backlog doc's Beta plan and the feasibility doc's newest Design decisions (two 2026-09-28 rows at the end: the Leave fix and Beta telemetry).
2. **The hearing-aid clipping fix is PR #19 and TestFlight build 0.1 (116)** (2026-09-30 evening; see "Done on 2026-09-30 (evening)" below), with three more app items. **Checked on Steve's iPhone (runs 90–96, below): the fix works.** Since build 116, PR #19 also drops a message that arrived while iOS never started audio (run 94, during a phone call; it had played at the start of the next conversation). **Next:** a TestFlight build with that (ask first), and a run rung during a call; watch tap → first audio on the new build (the watch shares the pipeline); then merge PRs #19–#21 (#20 and #21 are already deployed). The Test Bot answers on the live relay: its reviewer invite is `TEST_BOT_INVITE` in `config.sh` (overandout.app/i/<code>); keep `bot.ts --account` off Steve's Mac or it takes the bot's rings. For external TestFlight: Steve enters the review notes (`deploy/appstore/beta-review-notes.md`) and his contact details, creates an external group and its public link, then sets `TESTFLIGHT_URL` and redeploys the site.
3. **Where performance stands** (runs 70–72, TestFlight build 102 = PR #16; feasibility doc): first press → go-ahead 0.42 s, → talk-start at the relay 0.80 s (1.29 s on build 99); app closed with the extension, tap → first audio 0.75 s (first audio comes 48 ms after watchOS makes the app active, 0.70 s after the tap); in app 1.65 s (2.30 s; the Opus bot cut the replay from 1.44 s to 0.89 s). All the watch's traffic goes through the paired iPhone ("proxy" on every request, 0.17–0.45 s round trips over one reused HTTP/2 connection). Unexplained: a request waits 0.25–0.5 s before the network stack starts it. Steve (2026-09-30): enough performance for now; the queue-time mark and an early audio-engine start are backlog rows. Run 68's extension never launched (no nseStarted in the watch's log): watchOS's choice.
4. **Then** (backlog, "2 Before the Beta"): find why the watch's first audio comes 0.3 s later after the audio session than in build 69 (runs 61, 63: tap → first audio 0.85–0.88 s; the new audio-queue timing of first audio helps); then the rest of the Beta plan. Steve's Ring Me On is Apple Watch (the default now: the watch rings first).
5. **Already done:** the Leave fix (build 76), the TestFlight update test (run 56: the channel survives), telemetry and usage analytics (live 2026-09-29; see Done and Deployment today), builds 79, 81 and 84. **TestFlight feedback:** App Store Connect has no email for it; use the App Store Connect iPhone app's notifications, or the webhook (backlog).
6. **Branches:** `main` has everything merged up to PR #18. Open: PR #19 `hearing-aid-clipping` (the apps, the review notes, this file), PR #20 `always-on-test-bot` (worktree `.claude/worktrees/agent-aeeaa119fe33f69e4`), PR #21 `invite-testflight-node-replacement` (worktree `.claude/worktrees/agent-a98f480958a4f6303`). #20 and #21 both touch `deploy/gcp/config.example.sh` (different lines). Steve's `AGENTS.md` is untracked, his to commit.
7. **Device runs: hand each run's telemetry to the `run-analyst` subagent in the background** (Agent tool, `subagent_type: run-analyst`, `run_in_background: true`), right after Steve taps End, and ring the next run meanwhile. Never read Cloud Logging for a run yourself while Steve waits (Steve, 2026-09-30). Give it the conversation ID, the build, what the run was, the earlier runs to compare with, and ask for a running table with the median and range.
8. Ask Steve before anything outward-facing or billed: Google Cloud resources, deploying the relay, API or website, DNS (he adds GoDaddy records himself), App Store Connect or developer-portal changes Xcode doesn't make itself, TestFlight uploads (say before each), and deletions.

## Links

- **Beta telemetry spec (Claude Docs):** https://claude.ai/code/artifact/bbafed21-49d1-4086-af39-305d378e3463. The design Steve approved on 2026-09-28, updated to what was built.
- **Feasibility doc (Claude Docs):** https://claude.ai/code/artifact/59ab6e47-6e5d-4698-8bd1-173293953df9. Design decisions (date, decision, why, revisit if) and Prototype results (runs 1–55).
- **CI performance and audio tests plan (Claude Docs):** https://claude.ai/code/artifact/32cd38e1-241e-40df-a1a8-e59459bdcc05. Scenarios A–H, the macOS kit tests, per-burst audio levels in telemetry; Steve's answers are in its open questions.
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

## Done on 2026-10-01 (evening): Roll Over to iPhone (PR #38, merged and deployed)

Steve's scenario: a watch on its charger rang unanswered for 35 s. His choices: an opt-in setting, off by default; 12 s; 35 s in total; Decline reported; a late watch answer wins; only when the ring went to the watch; watch → iPhone only. Feasibility doc: a 2026-10-01 Design decisions row (it also records the researched alternative, a lock or charging check at ring time). Backlog: three rows.
- **Relay** (`relay.ts`): when `ringLookup` says `rollOver` and the ring went to watches, `armRollOver` starts a timer counted from the watch's push (`rollOverMs`, 12 s). If nobody answered, joined or declined by then, `rollOver` rings the account's reachable iPhones (`ringRolledOver`, or `rollOverSkipped` with none) with the first ring's expiry (`ringExpiresAt`, so 35 s in all), and withdraws the watch's prefetch push and polled ring. `answered()` (now with the device) and the new `declined()` cancel it. `answeredElsewhere`: after a rollover, a join from another device of a user whose watch reported an answer gets `moved` instead of the message.
- **API and accounts:** `rollOver` on `users/{uid}` (absent = off), `PATCH /v1/me {rollOver: boolean}`, in `GET /v1/me` and `ringLookup`; `POST /v1/rings/decline {conversationId}` (`main.ts`, beside `/v1/rings/answer`).
- **Apps:** iPhone Settings → Walkie-Talkie: "Roll Over to iPhone" under Ring Me On while it's Apple Watch, with a footer line (`AppModel.setRollOver`, the kit's `setRollOver`). Watch: the in-app Decline posts `/v1/rings/decline` (`reportDecline`); the 30 s in-app timeout doesn't.
- **Uses** PR #37's answer report (`/v1/rings/answer` at the watch's tap): it cancels the rollover, and after one it makes the iPhone's join give way.
- **Tested:** server `npm test` 129 pass (3 new rollover tests in `api.test.ts`, rollover in `accounts-suite.ts`); kit 50; the iPhone and watch simulator builds and a Release device build without warnings. A local relay (port 8098) with a new simulator pair: ignored → `ringRolledOver` at 12.0 s and an in-app ring sent to the iPhone; Decline on the watch at 1.3 s → `declineReported`, no rollover, the ring ran out at 35 s; iPhone not connected → `rollOverSkipped`. Not checked in the simulator: the toggle itself and the iPhone playing the rolled-over ring: on the new pair the iPhone app never became active after a relaunch (a `main` build did the same; backlog row). The PushToTalk path needs the device run.

## Done on 2026-10-01 (evening): build 160, runs 100–106, PR #37 (merged, relay not deployed)

- **TestFlight build 0.1 (160)** from `cdd9db8` (PRs #32–#36: minimum OS, mascots, the flaky test, the engine mark, small watches). Analysis by the `run-analyst` subagent per run.
- **Runs** (feasibility doc rows "100–102", "103", "104", "105–106"): 100 watch, app closed, extension didn't run: tap → first audio 3.21 s; 101 frontmost: 1.51 s; 102 extension ran: 0.67 s, and the engine starts 0.29 s after the audio session with the downloaded message playing 1 ms later (the "0.3 s" question, closed); 103 **failed** (below); 104 iPhone rung during a call: only the second message played (closed); 105 5 s airplane mode: the stream survived; 106 **failed** (below). iPhone push sent → first audio 1.13–1.50 s over hearing aids.
- **Run 103:** a 31 s message to the closed watch, tapped part way: watchOS froze the app (11 s stall), the stream then took 14.2 s to open, the relay's 35 s ring timer dropped the rest, the downloaded 5.2 s played and the mouth stayed on listening.
- **Run 106:** 20 s of airplane mode mid-message on the iPhone: the stream broke 3 s in and the app ended the conversation at once; the relay had kept nothing it forwarded live.
- **PR #37 (merged):** the watch reports an answer at the tap (`POST /v1/rings/answer`, which no app called before) so the relay keeps the message 30 s for the join; a join with nothing to replay ends a partly downloaded message (`prefetchedRestLost`). Both apps rejoin a dropped stream at most 2 s apart for 30 s ("Reconnecting…", the yellow antenna), resuming the burst being heard (`?resumeBurst=&resumeFrom=` on the stream request; the relay keeps a burst's sent frames 30 s after it ends, `resumeTtlMs`). The iPhone's Talk screen has the watch's connection glyph (`ConnectionGlyph` is in the kit now; `TalkController.unavailablePeer`). Checked in the simulators through a TCP proxy that drops every connection for 8 s (`outage-proxy.mjs` in that session's scratchpad: listen 8098 → relay 8097, `kill -USR1` cuts; build with `OAO_SERVER_HOST=localhost:8098`): both rejoined and played the whole message.
- **Small findings, not fixed:** `beta.ts run` prints "burst played" for frames that arrived but never played (run 104a); after a drop the iPhone's old stream lingered 58 s before `audioNeverActivated` (104a); a timeline upload over a connection the drop killed waits for the next flush (simulator).

## Done on 2026-10-01 (afternoon): App Store screenshots, the Beta's invite link, minimum OS, PRs #31–#36

- **App Store screenshots** (PR #31, uploaded): see "App Store screenshots" under the MVP list. `asc.ts listing` and `asc.ts screenshots [--replace]` (pushed to `main`, `eedb349`).
- **Website** (deployed by Steve's OK): `TESTFLIGHT_URL="https://testflight.apple.com/join/uvWBNqPG"` in `deploy/gcp/config.sh` (gitignored); invite pages say "Join the beta on TestFlight". The API and relay needed nothing: `main` matched what's deployed.
- **Minimum OS: watchOS 10.2 and iOS 17** (PR #32, Steve's decision): the oldest the Xcode 27 simulators run here. The watchOS 10 / iOS 17 availability checks are gone; `AVAudioApplication` for the record permission on both devices; two-parameter `onChange`. Checked in the iPhone simulator: the microphone prompt appears and onboarding moves on after Allow.
- **watchOS 10.2 simulator limits** (macOS 27): the simulator tool's taps and swipes don't reach it, and there is no Simulator.app here for desktop clicks. Its notification prompt can be pre-answered by writing the app's entry into `data/Library/BulletinBoard/VersionedSectionInfo.plist` with the simulator shut down (copied from a watchOS 27 simulator's entry, `authorizationStatus` 2). It shows the screens, but **the app aborts as soon as audio starts**: `AVAudioEngine.inputNode` → AURemoteIO "RPC timeout. Apparently deadlocked" in that runtime. So conversations on watchOS 10 need a device.
- **Mascots** (PR #33, by a subagent): Fox and Morticia had been shrunk to 78% for the round watch icon mask; `art/characters/icon-from-master.swift` remakes their icons from the masters at the others' size; GENERATION.md has the commands.
- **Flaky kit test** (PR #34): CI's virtual audio device can play faster than real time; the early-stop test returns then, and `flushHeld` won't `play()` a player whose engine is gone (an exception, so a crash).
- **Watch engine mark** (PR #35): `audioEngineStarted` on the watch's timeline; `beta.ts run` shows audio session → engine started → first audio. Simulator (42mm, watchOS 27): 87 ms, then first audio at once; tap → first audio 248 ms.
- **Small watches** (PR #36): on 40/41 mm screens (≤ 176 pt) the Talk screen's mascot shifts 8 pt right instead of 12, so the antenna clears End (it touched it on the SE 40mm). Checked: SE 40mm on watchOS 10.2 and Series 12 42mm on watchOS 27 (friends list, ring, Talk screen in a conversation). `OAO_DEV_AUTO_ANSWER=<seconds>` (debug simulator builds) answers in-app rings, for simulators the tools can't tap.
- **Local demo data for simulator work:** the relay on port 8097 with `DATA_DIR` in the session scratchpad held "Alex" (`dev:alex`) and mascot-only friends Mom, Jess, Dad, Grandpa, Leo and Maya as bots (sign in `dev:<name>`, `PATCH /v1/me {avatar}`, invites, `PATCH /v1/friends/{id} {favorite}`, a token file each for `bot.ts --account`). Add `FULL_TIMELINE_USERS=<Alex's id>` to the relay for `beta.ts run … --local`.
- **Lesson:** do local test merges in a temporary worktree, never by switching this checkout (Steve opened `art/characters/preview.html` from it while it was on a scratch branch).

## Done on 2026-09-30 (late): no "Couldn't reach Over&Out" alert after unlocking (not committed)

Steve saw the alert after the first launch, then locking and unlocking the iPhone. It came from the refresh on coming to the foreground: any URLError but "offline" became a modal alert. Likely cause: the first request after a suspension reuses an HTTP/2 connection that was closed meanwhile (`networkConnectionLost`, -1005). Fix: the kit's `AccountClient` retries a GET or PUT once on -1005 (POST/PATCH/DELETE aren't retried: the first may have landed); the foreground refresh is quiet (`refresh(quietly: true)`) and logs a `refreshFailed` event with the error code instead; pull-to-refresh and actions still alert. Two new kit tests (AccountTests 12 pass); the iPhone app builds without warnings. Not yet checked on a device: lock and unlock on a TestFlight build, and `beta.ts tester Steve` for any `refreshFailed`.

## Done on 2026-09-30 (night): runs 90–96 on build 116

Each run's telemetry went to the run-analyst in the background; the feasibility doc's Prototype results have them. The Test Bot rang Steve's locked iPhone (production push) with a message starting "Pineapple."
- **Hearing aids (90–93, 95):** "Pineapple" heard in full every time. The engine restarted 164–165 ms after first audio in 91, 92 and 93 (the clipping runs 87–88: 150–156 ms), and `audioRestarted` said "replaying 52/52/56 (0 rewound)": nothing had been reported played yet, so the whole start was replayed. No restart in 90. The rewind path (a restart after audio has played) hasn't happened on a device. Push sent → first audio 1.69, 1.09, 1.10, 1.18 s (median 1.14 s; build 106: 0.95–1.49 s); 90's push took 913 ms to arrive. Push received → first audio 776–826 ms, most of it the engine starting over HFP (565–710 ms after the audio session; first audio 14–22 ms after the engine; backlog row).
- **Speaker (96):** 0.93 s (run 89: 0.68 s): push delivery 623 ms; received → first audio 306 ms; engine 205 ms after the session, as before. No restart.
- **Found (94–95):** rung during a phone call, the iPhone joined and received all of 94, but iOS never activated its audio; on the iPhone only audio deactivation stops the pipeline, so the held message played at the start of 95. **Fixed on PR #19** (`TalkController.finish` → `AudioPipeline.discardPlayback()`, and an `audioNeverActivated` mark; a new kit test). Not yet in a build. 94's timeline was uploaded twice: the disk queue resent it once the app woke (the first upload probably did land).

## Done on 2026-09-30 (evening): the hearing-aid clipping fix and the Beta worklist (PRs #19–#21, build 116)

Committed and deployed by Steve's OK (see Deployment today); TestFlight build 0.1 (116) from PR #19. Design decisions (four 2026-09-30 rows) in the feasibility doc; backlog statuses updated and four new rows.
- **Clipping fix** (branch `hearing-aid-clipping`; the kit's `PlaybackLedger.swift`, `AudioPipeline.swift`): after a configuration change the new engine plays again every buffer the old one had scheduled but not played, and, if the change came within the first 0.5 s of a burst's played audio, the burst from its start (once per burst). A player generation number drops the stopped player's late callbacks. `audioRestarted`'s detail is now "engine restarted: replaying N (M rewound)". A failed restart counts what was held as played, so the speaker still drains.
- **Same branch, same build:** first audio (`firstAudioScheduled`, `burstAudioStarted`) is stamped on the audio queue (`onFirstPlayback` passes the time); conversation timelines go through a disk queue in `Telemetry` (`pending-timelines/`, sent at once, retried at each flush, 20 at most, 3 days; `Telemetry.shared.sendTimeline` set by `ConversationController.start()` and `TalkController.init`); debug watch builds report `uncleanExitDebug`, outside the "app crashed" alert. Also `deploy/appstore/beta-review-notes.md`: the TestFlight test information and review notes to enter in App Store Connect (bracketed values for Steve).
- **Tested:** the kit's 42 Swift Testing and 12 XCTest tests, 9 of them new (the ledger's rules; an engine stopped 150 ms into a 0.5 s burst drains only after all of it plays again; timelines surviving a relaunch and pruning). Debug simulator and Release device builds without warnings. Simulators on a local relay (port 8096): Bot → watch (156 frames, and a 104-frame reply), the watch's timeline through the queue; a timeline that failed with the relay down went out 5 s after the relaunch; Bot → iPhone in app (156 frames), its timeline through the queue. A configuration change can't be caused in the simulator: the device run is the real test.
- **Always-on Test Bot** (worktree `agent-aeeaa119fe33f69e4`, `server/src/test-bot.ts`; 12 new tests, `npm test` 121 pass): inside the relay when `TEST_BOT_USER_ID` is set; answers, greets (275 pre-encoded Opus frames, `server/src/test-bot-greeting.opus`, remade with `node tools/bot.ts greeting`), plays each message back; never rings (`Peer.noRings`). Standing invite `TEST_BOT_INVITE` on the API. To turn on: those two in `config.sh` (the bot is `u_NvlyGM47nb3JKca_`; the invite code from `openssl rand -hex 12`), then `deploy-api.sh` and `deploy-relay.sh`. The greeting is a macOS `say` voice (personal-use licence): record a real one first (backlog). While `bot.ts --account` runs on Steve's Mac it takes the bot's rings. `bot.ts send --account` now rings the bot's oldest friend.
- **Invite page and node replacement** (worktree `agent-a98f480958a4f6303`): `invite.html` offers "Join the beta on TestFlight" when `TESTFLIGHT_URL` is set in `config.sh` (only `https://testflight.apple.com/join/…` accepted), else today's "Coming soon". **Found: the live site's images are broken**: `firebase-hosting.ts` uploaded every file as UTF-8 text; fixed there, and the next `deploy-web.sh` repairs them. `setup-node-replacement.sh`: a Cloud Scheduler job (09:00 UTC on the 1st) starts a Cloud Run job that rolling-replaces the relay group one node at a time, as `node-replacer` with a four-permission custom role; $0. Not run.
- **Small watches** (Apple Watch SE 3 40mm simulator, watchOS 27): the friends list, the Talk screen idle and in a conversation (End, the glyph) fit; the in-app ring's buttons broke into "De-cline" and "An-swer", now one line (`lineLimit(1)`, `minimumScaleFactor(0.7)` in `IncomingRingView`). Not checked: watchOS 10.2 (the simulator tool's taps don't reach it).

## Done on 2026-10-01: build 133 and runs 97–99

- **Deployed by Steve:** PRs #22–#25 merged; the API and website from `f36f7a6` (the screen-name filter, overandout.app/terms, the favicon). TestFlight build 0.1 (133) from `main` (the sign-in agreement line, #23's discard fix).
- **Runs 97–99 (build 133):** 97 and 98 rang the **watch** (Ring Me On was Apple Watch), so the phone-call case wasn't tested: 98 ("Durian", during a call) timed out unanswered on the watch. 99 rang the iPhone (PushToTalk, hearing aids) and played only its own burst; push sent → first audio 2.21 s (join sent → relay joined 861 ms, the stream took 1.18 s to open; build 116: median 1.14 s), no restart. **Found:** 99 was marked `audioNeverActivated` though it played: `finish()` tested the live `audioActive`, which iOS has turned off by then. **Fixed** on branch `audio-never-activated-check`: test the conversation's own `audioActivated` mark.
- **Still to test on a build with that fix:** Ring Me On iPhone (check it first), ring during a call, hang up, ring again; only the second message should play, and the first conversation should carry `audioNeverActivated`. And whether 99's slow stream open repeats.

## Done on 2026-10-01: Terms of Use (PR #22)

- **Why:** App Review guideline 1.2 (user-generated content): reviewers commonly ask that people agree to terms with zero tolerance for objectionable content or abusive users. No custom EULA: Apple's Standard EULA covers the licence (App Information → License Agreement stays default).
- `web/public/terms.html` (overandout.app/terms; adapted from Basecamp's CC BY 4.0 policies, attribution on the page): age 13+, community rules, reports and removal ("usually within a day"), content licence, Apple's Standard EULA, no warranty, not for emergencies, liability limits. Footer links on every page. Not deployed.
- iPhone: "By signing in, you agree to the Terms of Use and Privacy Policy" under the Sign in with Apple button; Terms of Use in Settings and About.
- `deploy/appstore/beta-review-notes.md`: leave "Sign-in required" unticked (Sign in with Apple only; reviewers use their own Apple ID); the terms in the safety paragraph.
- Not a lawyer's text: Steve has it reviewed before the App Store release.
- PR #23 carries the "message whose audio never started" fix, which missed PR #19's merge.

## Done on 2026-09-30: CI performance and audio tests (PR #18, merged)

The plan is the Claude Doc in Links. Merged to `main` as PR #18; nothing deployed.
- **Server CI** (`.github/workflows/server.yml`, pushes and PRs touching `server/`, weekly): `npm test`, the 25 Firestore-emulator tests (Java 21, gcloud's emulator), and the relay perf suite.
- **Relay perf suite** (`server/perf/`, `npm run perf`): bot-to-bot scenarios A–H against a relay in its own process (ring-to-start over WebSocket and HTTP, live, back-and-forth, the watch's HTTP sender, first press cold and pre-connected, an unanswered ring, Opus vs PCM, 50/200 pairs of load). Every burst is checked byte for byte. A TCP proxy adds 150 ms each way, so network cost counts in legs (one-way trips): the watch's HTTP answer → first audio is 4 legs, a cold WebSocket answer 8. `compare.ts` judges results against `perf/budgets.json`; PRs run the base commit's relay and theirs 5 times in turn on one runner; `main` keeps a history in the `perf-history` artifact (90 days, re-uploaded by every run). Integrity and counts fail the build; timings and simulated-network numbers only warn until tuned (`enforce` in `budgets.json`). After a deliberate change: `node perf/run.ts --suite full --out r.json && node perf/compare.ts --full r.json --update-budgets`.
- **Kit CI** (`.github/workflows/kit.yml`, macOS, PRs and pushes to `main` touching the kit or relay, weekly, by hand): all the kit's tests plus `AudioLevelTests` (tones and a speech clip through Opus and the capture converter: level, pitch, clipping, SNR) and `RelayEndToEndTests` (Swift → a local relay → Swift). Their measurements go to `kit-history`. Written without a Mac: the first run is the first compile. Open question: whether `macos-26` has a new enough Xcode; Steve's Mac as a self-hosted runner is the fallback.
- **Per-burst audio levels** (Steve's OK 2026-09-30; no privacy-policy change): the kit's `AudioLevel`; the apps mark `burstLevelSent`/`burstLevelPlayed` (RMS, peak, frames, clipped; the mic's port kind; the iPhone's volume); `oao.device` gets `levels` and the `silentBurstSent`, `silentBurstPlayed`, `clippedBurstSent` problems; `oao.levels` says how much quieter a listener played than the talker sent; `beta.ts` shows them; a silent-sends chart (metric `oao_silent_sends`, chart only). Needs a relay deploy, `telemetry-monitoring.ts apply` and a TestFlight build, each with Steve's OK.

## Done on 2026-10-01: the screen-name filter (branch `screen-name-filter`)

- **Why:** App Review guideline 1.2 asks apps with user-generated content to filter objectionable material; screen names were unchecked. Photos stay report-based for the Beta (Cloud Vision SafeSearch is the later option, a billed resource).
- `server/src/name-filter.ts` with `server/src/name-blocklist.txt` (Shutterstock's LDNOOBW English list, CC BY 4.0, attributed in the file): whole words after folding accents, case and look-alike digits; runs of single letters joined; listed phrases; the whole name from six letters; four roots matched inside words. Exceptions for real names: Dick, Butt, Mong (and "s&m", which matched initials). No name in macOS's 1,308 proper names is refused.
- `Accounts.rename` refuses with 400 `name-not-allowed` ("That name isn't allowed. Choose another one.", shown by existing builds); a disallowed name from Apple at first sign-in becomes "Friend". Existing names aren't rechecked.
- Server only: needs an API deploy. `npm test` 126 pass (5 new).

## Done on 2026-09-30: device runs 73–89 on build 106 (the Swift 6 check)

Each run's telemetry went to the `run-analyst` subagent in the background (Start here, step 7). Results are in the feasibility doc's Prototype results; follow-ups are backlog rows.
- **Watch, app closed (73–79):** the extension ran in 6 of 7. Tap → first audio median 0.80 s, range 0.53–1.00 s (0.75–0.88 s before). The spread follows when watchOS makes the app active. Without the extension (73): 3.79 s, as in run 68. Joins take 1.4–3.5 s over the iPhone proxy, as before.
- **Watch in app (83):** tap Answer → first audio 1.66 s (1.65 s in run 72).
- **The watch rebooted once**, going black as Steve tapped Test Bot after run 83. There was no OverAndOutWatch crash log and no uncleanExit, so it looks like a watchOS reset. Watch for a repeat.
- **Watch first press (84, 3 min after the reboot):** go-ahead 0.44 s, talk-start at the relay 0.90 s; the first requests through the iPhone were slow. Run 83's accidental tap was 0.37 s and 0.52 s.
- **Locked iPhone (85–89):** push sent → first audio 0.95, 1.02, 1.42 and 1.49 s over the hearing aids, and 0.68 s on the speaker (0.89–1.17 s before). Over HFP the engine takes 0.4–0.7 s to start, against 0.2 s on the speaker.
- **Clipping:** 87 and 88 restarted the engine 150 ms into playback and clipped the first word; the other runs were clean. Lock Screen reply: Talk → go-ahead 0.96 s.
- **Telemetry reads:** Cloud Logging returned 500s a few times (retry). One analyst ran `beta.ts pull Steve` unasked. After that the permission checker blocked the analysts' `beta.ts run` twice, and Steve then OK'd reading runs 88 and 89 directly. Keep analysts read-only and say so in their brief.

## Done on 2026-09-29 (Swift 6): the language-mode migration (PR #17, TestFlight build 106)

- **What:** `SWIFT_VERSION = 6.0` for the three targets, and `.swiftLanguageMode(.v6)` for the package and its tests. Debug simulator and Release device builds are clean of compiler warnings (the 10 old warnings are gone too). Deployment targets are unchanged (iOS 16, watchOS 9). How to check a change, and who owns what: `app/README.md`, "Swift 6".
- **Design:** `RelayConnection`, `AudioPipeline`'s API, and the watch's `ConversationController` and `WatchAccount` are `@MainActor`, with delegate methods `nonisolated`. The audio queue's state is `AudioQueueState` (queue-confined, `@unchecked Sendable`). All the pipeline's callbacks now arrive on the main actor (the apps' own `DispatchQueue.main.async` hops were removed, so it's still one hop per frame). `Telemetry`, the session stores and the notification extension keep their state in `OSAllocatedUnfairLock`. The extension now delivers exactly once, whether the download or the expiry comes first; the two used to race.
- **Runtime traps found and fixed:** a closure written in a main-actor type is main-actor unless it's `@Sendable`, and Swift 6 traps if a framework calls it off the main thread. The watch's stall watchdog did, a second after launch (found on the simulator). A SDK probe found two more: `AVAudioSession.requestRecordPermission` (iPhone onboarding) and `WCSession.sendMessage`'s handlers.
- **Tests:** package 39 (6 new: relay ordering, outbox hold, a stale POST after reconnecting, a failed send, audio drain on the main actor, concurrent telemetry); also clean under Thread Sanitizer.
- **Simulators** (a local relay on port 8093; the 8080 one from an earlier session was left running):
  - Watch → Bot: 177 frames; press → go-ahead 156 ms.
  - Bot → Watch: in-app ring and Answer; answer → first audio 33 ms; a reply of 116 frames.
  - iPhone → Bot: 125 frames through the microphone tap.
  - Bot → iPhone: a live burst; first frame → audio 53 ms.
  - On the watchOS 10.2 simulator the app launched and ran without a trap, but talking wasn't tested there.
- **Not done:** device timing and PushToTalk (need a TestFlight build), and physical iOS 16/watchOS 9.

## Done on 2026-09-29 (late night): runs 64–66 on build 95, and the first press

- **Runs 64–66** (build 95, the feasibility doc has them): the new screens worked on Steve's watch (a notification and an in-app Answer open the caller's screen, the antenna yellow → green, red and "Didn't answer" after a ring timed out). Slower: tap → first audio 1.13 s with the app closed (the audio session came 0.90 s after the tap, 0.08 s in run 63) and 2.07 s in app (the join and its replay took about 1 s each way over the open stream). The first press took 2.49 s to the go-ahead: 2.10 s of it opening a cold relay connection.
- **Talk right away** (`Watch/ConversationController.swift`): the burst starts once the audio session is up, without waiting for the relay; talk-start and the frames queue in `RelayConnection`'s outbox (which already held sends until hello-ack) and go out when the stream opens. `talkReady` is now the audio alone; `connected` (the stream) drives the antenna. A stream that doesn't open in 10 s, or closes first, plays the failure haptic and records "Couldn't connect".
- **Pre-connect from the Talk screen:** `talkScreenShown`/`prepare(for:)` open the stream (the in-app ring's `preconnectRelay`) when a Talk screen appears, again after a conversation ends or the app comes back; `stopPreparing` on leaving, in the background, or after 60 s idle. The outgoing start reuses it. Simulator: press → go-ahead 0.16 s pre-connected, 0.08 s cold on the local relay (so nothing had to queue there).
- **Diagnostics:** `RelayConnection(stampsArrivals: true)` (watch only; the iPhone keeps the main queue) delivers to its own queue and stamps `lastArrivalMs`; marks `helloAckArrived`, `joinedArrived`, `firstFrameArrived` next to the handled ones, `audioActivationReturned` (off the main queue) before `audioActivated`, `talkScreenShown`, the receiver's join POSTs, and `mainStall` from 200 ms (30 per conversation at most).

## Done on 2026-09-29 (night): the watch's friends list (PR #13, then branch `watch-talk-glyphs`)

- **Why** (Steve): the watch's one screen looked the same whether you were about to ring someone or already talking, and Talk rang a friend picked earlier. Design decision 2026-09-29 in the feasibility doc.
- **Friends list, the home screen** (`Watch/FriendsListView.swift`): photos, favorites first, Settings top right; the friend in a conversation moves to the top with "Live", "Talking", "You're talking" or "Connecting…" (yellow), with the same antenna glyph. How a conversation last ended badly shows on that friend's row with the time ("Didn't answer", "Can't reach", "Couldn't connect" in red with the struck-through antenna; "Missed" in orange; "Continued on iPhone" in silver): `ConversationController.outcomes`, by friend, cleared when a new conversation with them starts or they talk. It shows even with one friend.
- **Talk screen per friend** (`Watch/TalkView.swift`): only that friend. Back, their picture under it, the mascot as large as the screen allows with its antenna between the time and End (mouth about 65 pt across, up from 52), "HOLD TO TALK" curved inside the mouth under the microphone while idle (the kit's `MascotTalkButton` `hint:`, drawn by `ArcText`; the iPhone passes none), and their name below with a connection glyph (`Watch/ConnectionGlyph.swift`, shape and colour, for colour-blind people): the antenna with waves animating outward, yellow, while connecting (still on watchOS 9); the antenna, green, in an open conversation; the antenna struck through, red, when they didn't answer or can't be reached, until you ring again or they talk; nothing when idle. End (a red ✕) top right during a conversation. Holding the mouth on another friend's screen ends that conversation and rings this friend without a word on screen (`talkPressed(to:)`, as on the iPhone; Steve: the Talk screen shows nothing about another friend). Presses in the first 0.5 s are ignored, so a double tap on a row can't ring anyone.
- **Rings:** the in-app ring (`IncomingRingView`) covers any screen. Answering it, or tapping the ring notification, sets `ConversationController.arrivedFrom` last in `answer()`, and `ContentView` opens that friend's screen with the list behind it.
- **Back to the list** after 2 minutes away with no conversation (`ContentView.homeAfter`).
- **Removed:** `FriendPicker`, `WatchAccount.selectedFriend`/`selectedFriendId` (the defaults key is cleared on launch). Also fixed: the cached friends list now loads favorites first.
- **Checked in the simulator** (local relay, test friends Alice, Bob and Cara run as bots): list, Talk, talking (Bob's bot heard 2.9 s), End, an in-app ring over another friend's screen, Answer, the notification tap (`simctl push`), Back, "In a conversation with", Settings, the 2-minute return (same process). Not checked: a device, small watches, watchOS 10.2.

## Done on 2026-09-29 (evening): the watch rings first, build 89, runs 62–63

- **The watch rings first** (Steve; design decision 2026-09-29): a watch joining an account no longer pins rings to the iPhone; the iPhone's one-time question defaults to Apple Watch. API deployed (`87d3e57`); PR #12.
- **Build 89:** that, the Leave notice worded for the watch too ("iPhone walkie-talkie is off"), a "Walkie-talkie is back on" banner when the app rejoins, and an in-app download of the held message when watchOS hands a push to the frontmost app (it skips the extension then; run 60).
- **Run 62** (app left frontmost): in-app ring and pre-connect, tap → first audio 1.39 s (3.45 s in run 60). **Run 63** (app closed): the extension prefetched, tap → first audio 0.85 s; the watch's timeline upload was lost and recovered with a pull.

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
- **Watch main screen** (runs 41–42; replaced by the friends list and a Talk screen per friend on 2026-09-29): the mascot on indigo, its mouth is hold-to-talk (only the mouth and ring respond; the mouth shows idle, talking with the antenna ball lit, connecting, and the friend talking), an in-app ring that wiggles the mascot with Answer and Decline below it. Geometry in `MascotGeometry` (the kit's `MascotTalkButton.swift`), art `OverAndOutMascot` in the watch's assets. "Is talking" lasts until the speaker has played everything (`AudioPipeline.onPlaybackDrained`).
- **Profile photos** (run 43, API `3880fac`): each person picks one in Settings or onboarding; a 256 px JPEG in Firestore `photos/{uid}`, `photoVersion` on the user and in friend lists, `PUT`/`DELETE /v1/me/photo`, `GET /v1/users/{id}/photo` for the owner and friends only; `Avatar` and `PhotoCache` in the kit; the watch shows photos in its friend picker and on an in-app ring, downloaded after its idle friends reload. Report has an "Inappropriate profile photo" reason. The privacy policy covers photos. The Test Bot has a photo.
- **Tools:** `node tools/test-account.ts invite` makes an invite from the bot. `OAO_BOT_TOKEN_FILE=<file>` keeps a local bot apart from the Google Cloud one (`OAO_API=http://localhost:8080 node tools/test-account.ts create`, then `invite`, and `bot.ts send --account` with the same variable). A watch simulator left with a deleted account's session needs `xcrun simctl keychain <watch> reset`.

**App Store screenshots (PR #31, uploaded 2026-10-01; slide 6 still shows the old Fox and Morticia sizes, recapture before the release):** `deploy/appstore/screenshots/`: `raw/` holds simulator captures (iPhone 18 Pro Max, Apple Watch Series 12 46mm) of demo account "Alex" with mascot-only demo friends (Mom, Jess, Dad, Grandpa, Leo, Maya) on a local relay; `swift compose.swift` (run in that directory) writes `out/`: 7 iPhone slides at 6.9" (1320×2868, indigo, headlines; the first is iPhone and watch together) and 4 watch shots (416×496, unframed, the watch clock painted to 9:41), all without alpha. Uploaded to version 1.0's en-US listing (7 in APP_IPHONE_67, 4 in APP_WATCH_SERIES_10, all processed) with `node deploy/appstore/asc.ts screenshots`; `asc.ts listing` shows them, and `screenshots --replace` swaps in a new set. Slide 2, "Talk without unlocking", is the PushToTalk Lock Screen from Steve's iPhone (`raw/phone-locked.png`, 921×2000 as sent through chat), with Jess's name and mascot, 9:41 and no Silent Mode bell painted over it by `lockScreenShot()`. The in-app ring slide was dropped: iPhones with PushToTalk play a friend's message at once and never show it. To recapture: seed demo accounts by signing in `dev:<name>` users, `PATCH /v1/me {avatar}`, invites and `PATCH /v1/friends/{id} {favorite}`; `bot.ts listen|send --account` with a token file per friend gives the talking, listening and ring states.

**Still to do for the MVP:** the App Store listing (screenshots: done, above; description, privacy label: identifiers, name, usage data, and User Content → Photos or Videos for profile photos, linked to the user, app functionality; the privacy policy is at overandout.app/privacy, support at /support), the website in the new branding (`web/public`), retiring the shared relay token (backlog), and the watchOS 9–11 checks (backlog).

## Where things stand

- **Accounts (2026-09-27):**
  - **API** (`server/src/api.ts`, `accounts.ts`, `session.ts`, `apple.ts`; `api-main.ts` for Cloud Run): Sign in with Apple with a nonce; Ed25519 JWT session tokens (30 days, refreshed when a day old, refreshable up to a year past expiry while the session exists); the iPhone mints the watch's session (`POST /v1/auth/device`); profile, friends, single-use 7-day invites, blocks, reports (logged as `[report]`, emailed by an alert), push registration (`PUT /v1/me/device`), account deletion with Apple token revocation.
  - **Firestore model:** `users/{uid}` (with `photoVersion`) with `friends`, `blocks`, `devices` and `sessions` subcollections; `appleSubs/{sub}`; `invites/{code}` (TTL on `expireAt`); `reports/{id}`; `photos/{uid}`. The account logic runs on a small `Docs` interface: Firestore REST with atomic commits and preconditions, or `MemoryDocs` locally.
  - **Relay:** accepts session tokens (user and device from the token); the shared token only reads diagnostics (since `342b8c8`). An account can only ring a friend (`ringLookup`, one Firestore batch read per ring); one kind of device rings (see Done on 2026-09-28); otherwise `talk-refused`. Diagnostics are shared-token only; `POST /v1/devices` only works on a relay with `SHARED_TOKEN_CLIENTS=1`.
  - **Tests:** `npm test` runs 119 (94 pass, 25 skip without the emulator); `npm run test:firestore` runs 25 against the Firestore emulator. The kit's tests: 24 (`swift test`, or `xcodebuild test -scheme OverAndOutKit` on a simulator).
- **iPhone app (`app/iOS`):** sign-in, onboarding (screen name and optional photo, Focus step, watch), friends list with photos, invite via the share sheet, invite acceptance sheet (universal links), friend page (report with reasons and optional block, block, remove), settings (photo, screen name, watch status and re-send sign-in, Focus help, blocked people, privacy and support links, About Over&Out, sign out, the Delete Account screen), and now talking: a Talk screen per friend, PushToTalk, Settings → Walkie-Talkie.
- **Branding (2026-09-27, `0e65ca9`):** the icon ("Chrome Tomorrow" mascot), the stacked wordmark and light/dark semantic colors are in each target's `Assets.xcassets`; `OverAndOutKit/Brand.swift` has the palette and `.brandScreen()`. The iPhone's Friends and sign-in screens have a masthead; the watch's main screen is the mascot (above). Source art, exports and usage notes are in `art/` (see `art/README.md`). The website (`web/public`) doesn't use it yet.
- **Watch app:** its session comes from the iPhone (`Watch/WatchAccount.swift`), stored in the Keychain under the app group; friends from the API, cached, on the friends list (the home screen) with a Talk screen per friend; push token registered under the account; token refresh and friends reload 5 s after coming to the front and only when idle (never on the ring path). The shared token is gone from the builds.
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
  - instance group `relay` (zone us-central1-a) with one node, `relay-1` (e2-micro, COS, 10 GB boot disk, 10 GB data disk `relay-1-1`), template `relay-<commit>`, **running `ac753df`** (branch `always-on-test-bot`, PR #20, with the Test Bot on; deployed 2026-09-30);
  - static IP `walkie-relay-ip` `35.209.96.216` (Standard tier), on `relay-1`;
  - Firestore (default) database, TTL policies on `timelines.expireAt` and `invites.expireAt`;
  - service accounts `relay-node` (Firestore, logs, metrics, image pull, its secrets) and `account-api` (Firestore, the API's secrets);
  - Cloud Run service `api` (`https://api-yqgprbu3ja-uc.a.run.app`, scales to zero, max 4 instances, running `ac753df` with `TEST_BOT_INVITE` set, 2026-09-30);
  - Firebase added to the project (Steve accepted the terms in the console); Hosting site `walkie-talkie-relay` (`walkie-talkie-relay.web.app`) with the custom domains overandout.app and www.overandout.app (a redirect to the root); `/v1/*` rewritten to `api`;
  - Artifact Registry repo `relay` (images `relay` and `api`); Secret Manager secrets `relay-token` (version 2 since 2026-09-28; Steve destroyed version 1, the leaked value), `apns-key`, `acme-eab`, `session-signing-key`, `session-public-keys` (key ID `k20260927`) and `apple-siwa-key`;
  - health check `relay-health`, firewall rule `walkie-web` (80/443), two uptime checks and alert policies, and the alert policy "Over&Out: user report";
  - **telemetry (2026-09-29):** log `oao-telemetry` (the relay's entries; the API's are in its Cloud Run stdout), 11 log-based metrics `oao_*`, the dashboard "Over&Out Beta" (https://console.cloud.google.com/monitoring/dashboards/builder/8c95ff4a-8e0e-46cc-9855-3242ae13fe62?project=walkie-talkie-relay), alert policies "Over&Out: rings failing", "APNs setup", "API errors", "app crashed", "dropped conversations", "problem report", and TTL policies on `diagnostics.expireAt` and `feedback.expireAt`. The relay and the API run `ec72ef6` (2026-09-29). **Usage analytics (2026-09-29):** metrics `oao_actions` and `oao_daily`; Cloud Run job `stats` (the API image, `node src/rollup-main.ts`, as `account-api`, which now also has `roles/logging.viewer`; `deploy-api.sh` keeps its image current); Cloud Scheduler job `stats-daily` (us-central1, 00:30 UTC; Cloud Scheduler enabled); Firestore `stats/{date}`.
  - **2026-09-30 (Steve ran them):** `telemetry-monitoring.ts apply` (the per-burst levels' metric and chart); the website from branch `invite-testflight-node-replacement` (PR #21; the images are no longer mangled; no `TESTFLIGHT_URL` yet, so the invite page still says "Coming soon"); `setup-node-replacement.sh`: service account `node-replacer`, custom role `relayNodeReplacer`, Cloud Run job `node-replacement`, Cloud Scheduler job `node-replacement-monthly` (09:00 UTC on the 1st; the second of the 3 free jobs). Run it now: `gcloud run jobs execute node-replacement --region=us-central1 --project=walkie-talkie-relay` (about 2 minutes without the relay).
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
- **One run at a glance:** `node server/tools/beta.ts run <conversationId>` (or `run latest Steve`): the press, answer and network steps the feasibility doc compares. For the analysis, always use the `run-analyst` agent in the background (`.claude/agents/run-analyst.md`; read-only, compares with earlier runs from this file), one per run, so the next run can start at once (Start here, step 7).
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
- The Test Bot and `bot.ts` send Opus (encoded by `swift tools/opus-frames.swift`, macOS only); add `--pcm` for raw PCM.
- More test friends (2026-09-29): sign in `dev:<name>` users with `POST /v1/auth/apple`, befriend them with `POST /v1/invites` and `/accept`, give each a `local:<userId>` device with `PUT /v1/me/device {platform: "watch"}`, and write a bot token file (`{api, userId, name, token, expiresAt}`) per friend for `OAO_BOT_TOKEN_FILE=… bot.ts listen|send --account`. The ring notification's tap: `xcrun simctl push <watch> <bundle> ring.json` with `conversationId`, `from` and `fromName` beside `aps`, sent while the relay still holds the ring (35 s).

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
