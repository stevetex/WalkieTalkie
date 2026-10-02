# Phase 0 cutover: the v2 service, the tester data, the baseline freeze

The runbook for section 7 of [ANDROID_WEAR_OS_PLAN.md](../../ANDROID_WEAR_OS_PLAN.md). The
contract is [contracts/README.md](../../contracts/README.md). There are three testers, so there's
no bridge: v1 retires in one window. The v2-only service is deployed, the tester data is
converted around the deploy, and everyone updates to the v2 build. Every step that deploys,
reads or writes production, or uploads to TestFlight needs Steve's OK first (AGENTS.md). Each
step says what proves it worked and where to stop.

Commands run from the repository root, with `export PATH=$HOME/google-cloud-sdk/bin:$PATH`.
What each data pass writes is in [server/src/migration.ts](../../server/src/migration.ts).

## 0. Before anything

- The Phase 0 pull requests are merged; server and kit CI are green.
- Write down the deployed revisions, the rollback point:
  `curl -s https://relay-1.overandout.app/healthz` and `curl -s https://overandout.app/v1/health`.
  The v1 server's API image and relay revision are what `deploy-api.sh <rev>` and
  `deploy-relay.sh <rev>` redeploy.
- Tell the testers when the window is: from step 4 until they update (step 6), builds 165 and
  earlier can't sign in or talk.

## 1. Snapshot and plan (read-only; ask first: it reads production with Steve's credentials)

```bash
mkdir -p ~/oao-snapshots && chmod 700 ~/oao-snapshots
node server/tools/migrate-v2.ts snapshot --firestore --project walkie-talkie-relay --out ~/oao-snapshots/pre-phase0-$(date +%Y%m%d-%H%M).json
node server/tools/migrate-v2.ts plan --firestore --project walkie-talkie-relay
```

The snapshot holds push tokens and Apple subjects: it stays in `~/oao-snapshots` (mode 600),
never in Git or chat; the tool refuses a path inside a repository. `plan` writes nothing and
prints the counts it would change (users, identities, devices, pointers, sessions).

**Stop if** `plan` reports a problem (an identity or `appleSubs` mapping naming another account).

## 2. Rehearse on a copy

```bash
FIRESTORE_EMULATOR_PORT=8186 gcloud emulators firestore start --host-port=localhost:8186 &
node server/tools/migrate-v2.ts restore --emulator localhost:8186 --from ~/oao-snapshots/<snapshot>.json
node server/tools/migrate-v2.ts apply   --emulator localhost:8186 --batch 25 --checkpoint /tmp/oao-rehearsal-checkpoint.json
node server/tools/migrate-v2.ts verify  --emulator localhost:8186
node server/tools/migrate-v2.ts cleanup --emulator localhost:8186 --apply
node server/tools/migrate-v2.ts verify  --emulator localhost:8186   # "All v2, and no v1 data left."
```

`verify` reads every record the way the v2 service does (`server/test/migration.test.ts` checks
the same on v1-shaped records, through the v2 accounts code).

**Stop if** `verify` reports anything but `watchSessionsWithoutParent` before cleanup, or cleanup
refuses.

## 3. Upload the v2 build (TestFlight; say before uploading)

```bash
deploy/appstore/testflight.sh --notes "Phase 0: the v2 service. Update when Steve says the service has changed over."
```

Wait for processing. Testers don't install it yet: a v2 build can't talk to the v1 service.

## 4. The cutover (writes production and deploys; ask first)

In one sitting, in this order:

```bash
# a. The additive pass: v2 fields beside v1's. The v1 server still reads everything.
node server/tools/migrate-v2.ts apply  --firestore --project walkie-talkie-relay --production --batch 25 --checkpoint ~/oao-snapshots/phase0-checkpoint.json
node server/tools/migrate-v2.ts verify --firestore --project walkie-talkie-relay

# b. The v2-only service. v1 builds stop working here.
deploy/gcp/deploy-api.sh      # checks /v2/health and /v2/config
deploy/gcp/deploy-relay.sh    # about 2 minutes without the relay; checks /healthz and /v2/time
deploy/gcp/deploy-web.sh      # overandout.app/v2/** only

# c. Again, for anything the v1 server wrote between a and b.
node server/tools/migrate-v2.ts apply  --firestore --project walkie-talkie-relay --production
node server/tools/migrate-v2.ts verify --firestore --project walkie-talkie-relay
```

The pass keeps every ID, skips anything already v2, and stops (writing nothing more) on
ambiguous ownership; rerunning resumes after the checkpoint. The pass must run before the deploy:
the v2 service finds accounts only by their identity index, so a sign-in it served first would
make a new account.

**Check:** `curl -s https://overandout.app/v2/config` names relay protocol 2 and `"versions":[2]`;
`curl -s https://overandout.app/v1/health` is 404.

## 5. Steve's devices first

Steve updates the iPhone app (the watch app and its extension come with it), then:

| Run | Expect |
| --- | --- |
| Watch, app closed, notification tapped | the extension prefetches by ring ID; tap → first audio about 0.7 s (run 102: 0.67 s) |
| Watch, in app, in-app ring answered | answer names the ring (HTTP 200); about 1.5 s (run 101: 1.51 s) |
| iPhone locked, PushToTalk (Ring Me On: iPhone) | push sent → first audio about 1.1 s (runs 90–95: median 1.14 s) |
| Roll Over to iPhone, watch ignored | the iPhone rings with the same ring ID 12 s later |
| Late tap on a ring that timed out | "Missed", nothing plays (`ring-expired`) |
| iPhone signs out, watch offline | the watch's next request gets `session-ended`, it clears its account and audio |

Steve's devices, no debugger; the `run-analyst` subagent per run (Ring Me On checked before the
iPhone runs). The Test Bot (`node server/tools/bot.ts send …`) rings from this Mac.

**Roll back** if a gate fails and a corrective release isn't quick: see "Rollback" below.

## 6. The other testers update

Tell them the service has changed over and to update from TestFlight. Their watches ask the
updated iPhone for a session the first time the watch app opens.

## 7. Retire the old watch sessions (writes production; ask first)

Once every tester's iPhone has the v2 build: the watch sessions the v1 iPhones made have no
parent, so a sign-out on the phone can't end them. They end now; each watch asks its iPhone again.

```bash
node server/tools/migrate-v2.ts retire-watch-sessions --firestore --project walkie-talkie-relay --before <step 4's time, ISO>
node server/tools/migrate-v2.ts retire-watch-sessions --firestore --project walkie-talkie-relay --before <step 4's time, ISO> --apply --production
```

## 8. Remove the v1 data (deletes production data; ask first)

After the gates pass and nothing points back to v1. It refuses unless `verify` finds no problems.

```bash
node server/tools/migrate-v2.ts cleanup --firestore --project walkie-talkie-relay
node server/tools/migrate-v2.ts cleanup --firestore --project walkie-talkie-relay --apply --production
node server/tools/migrate-v2.ts verify  --firestore --project walkie-talkie-relay   # "All v2, and no v1 data left."
```

It removes users' `appleSub` and `ringOn`, devices' `platform`, `pushToken`, `pushType` and
`apnsEnvironment`, sessions' `platform` and `deviceId`, every `appleSubs` document, and every
`pushTokens` pointer that isn't its device's v2 one. Rolling back after this means restoring the
snapshot.

## 9. Freeze the commercial baseline

- Tag the source: `git tag -a commercial-baseline-v2 <commit> -m "Phase 0 baseline: API v2, relay protocol 2, audio format 1"` (push with Steve's OK).
- Record in the feasibility doc: the TestFlight build number of the iPhone, watch and extension,
  the API and relay revisions, the contract's commit, and the step-5 measurements.
- Keep that build's archive (Xcode Organizer) and `contracts/` unchanged; later changes add to the
  contract (new optional fields, new optional events), never change it.

## Rollback

Redeploy step 0's revisions and restore the snapshot, writes and all (ask first: it deletes
everything written since step 1):

```bash
deploy/gcp/deploy-api.sh <step-0 API revision>
deploy/gcp/deploy-relay.sh <step-0 relay revision>
deploy/gcp/deploy-web.sh                     # from the step-0 commit: brings /v1/** back
node server/tools/migrate-v2.ts restore --firestore --project walkie-talkie-relay --from ~/oao-snapshots/<snapshot>.json --exact --production
```

Testers go back to build 165 in TestFlight. `--exact` deletes the account documents written
since the snapshot (accounts, friendships, invites, registrations), so the data is exactly what
the v1 server left; with three testers that's a few registrations and sessions, which the
apps make again on the next sign-in.
