# Hosting on Google Cloud

Three pieces, all in the project `walkie-talkie-relay`:

- **Relay nodes** carry the audio (below).
- **The account API** (`server/src/api.ts`) is the Cloud Run service `api`: Sign in with Apple, sessions, friends, invites, blocks, reports and account deletion. See "The account API and overandout.app".
- **overandout.app** is on Firebase Hosting: invite links, the apple-app-site-association file, the home, privacy and support pages, and `/v2/*` forwarded to the API.

The relay runs on **relay nodes** (option E in the feasibility doc): small VMs in a managed instance group on Container-Optimized OS (COS), each running one container. Server data (devices and metrics timelines) lives in Firestore, so a node holds nothing that matters. Restarts, OS updates (a deploy or the monthly node replacement) and replacing a failed node are automatic.

```
watch ──HTTPS──▶ relay-1.overandout.app ──▶ [ Caddy :443 ──▶ relay 127.0.0.1:8080 ] ──▶ Firestore (us-central1)
                  static IP, Standard tier     one container on COS, e2-micro           devices, timelines
                                               /data: certificates (stateful disk)      Secret Manager: token, APNs key
```

- **The image** (`server/Dockerfile`): Node 24 and Caddy. Caddy gets and renews certificates from Google Trust Services (Google Cloud's free Public CA, whose roots Apple trusts; the watch took ~1 s longer per connection to evaluate Let's Encrypt's newer chain) and proxies to the relay with streaming (`flush_interval -1`). Both run as an unprivileged user. It's built by Cloud Build from committed code, tagged with the commit, and stored in Artifact Registry.
- **The node** (`relay-node.cloud-init.yaml`): cloud-init mounts the data disk, opens ports 80 and 443 in COS's host firewall, and runs the container as the systemd service `relay`. The image and settings come from instance metadata.
- **The group** (`relay`, us-central1-a) is stateful. Each node keeps its name, its data disk and, per node, its static IP and hostnames, across replacements. Autohealing recreates a node that fails `relay-health` (HTTP port 80 `/healthz`, through Caddy to the relay) three times in a row.
- **Secrets**: the relay token (`relay-token`), the APNs key (`apns-key`), the Public CA account key (`acme-eab`) and the session tokens' public keys (`session-public-keys`) are in Secret Manager. Only the nodes' service account (`relay-node`) can read them. The image, template and metadata hold none.

## Setting up (once)

You need a Google Cloud project with billing enabled (the free tier still requires a billing account), and the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) signed in with `gcloud auth login`. Copy `config.example.sh` to `config.sh`, which is gitignored, and fill it in. Generate the relay token with `openssl rand -hex 24`. Then:

```bash
deploy/gcp/setup-firestore.sh
```

```bash
deploy/gcp/setup-relay.sh
```

```bash
deploy/gcp/deploy-relay.sh
```

1. `setup-firestore.sh` creates the Firestore database in us-central1 (the location is permanent), a 30-day TTL on metrics timelines, and the `relay-node` service account.
2. `setup-relay.sh` creates the image repository, copies the relay token and APNs key into Secret Manager, creates a Public CA account key there, and creates the health check.
3. `deploy-relay.sh`, the first time, builds the image and creates the instance group with no nodes.

Then add a node. Its hostnames need DNS A records pointing at its static IP first, or Caddy can't get certificates. A Public CA account key registers one ACME account, so for every node after the first, add a fresh key version first:

```bash
gcloud publicca external-account-keys create --format=json | gcloud secrets versions add acme-eab --data-file=- --project=walkie-talkie-relay
```

Then:

```bash
deploy/gcp/add-node.sh relay-1 --ip walkie-relay-ip --hostnames "relay-1.overandout.app walkie.cypressoakstudios.com"
```

Finally, add uptime checks that email `ALERT_EMAIL`:

```bash
deploy/gcp/setup-uptime.sh relay-1.overandout.app
```

## Deploying

Commit, then:

```bash
deploy/gcp/deploy-relay.sh
```

It builds the image for `HEAD` (about 30 s) unless that commit is already built, and creates an instance template `relay-<commit>`. Then it replaces the nodes one at a time. Each node gets SIGTERM, lets conversations in progress finish for up to 45 s, writes its buffered metrics, and comes back with the same name, IP and certificates, on the newest COS. A deploy (or the monthly node replacement, below) is also how nodes pick up OS updates. With one node, a deploy means about 2 minutes of downtime.

To roll back, deploy an earlier commit: `deploy/gcp/deploy-relay.sh <commit>`.

## Monthly node replacement (OS updates)

A node only gets a newer COS when it's recreated. The instance template names the image family (`projects/cos-cloud/global/images/family/cos-stable`), not an image, so every new node boots the family's newest image; no new template is needed. So that a month without deploys still brings OS updates, once:

```bash
deploy/gcp/setup-node-replacement.sh
```

It creates a Cloud Scheduler job `node-replacement-monthly` that, at 09:00 UTC on the 1st of each month (2 am Pacific), starts the Cloud Run job `node-replacement`. That job runs Google's gcloud image to do what a deploy does on the group's current template: it waits for any rollout in progress, replaces the nodes one at a time (max surge 0, max unavailable 1, recreate; the same name, IP and data disk), and waits until the group is stable. With one node that's about 2 minutes of downtime a month. A node that doesn't come back healthy stops the rollout, fails the execution and trips the uptime alert.

Both jobs run as the `node-replacer` service account, which has a custom role (`relayNodeReplacer`: get and update instance groups, use instance templates read-only, read zone operations), may act as `relay-node` (only that account), and may start only the `node-replacement` job. It's a custom role rather than `roles/compute.instanceAdmin.v1`, which could also create, delete and SSH into any VM or disk; instance groups have no per-group IAM policy, so the role is granted on the project, whose only group is `relay`.

A Scheduler job can't call the Compute API for this directly: a rolling replace needs a new version name each time (gcloud stamps it with the time), and a Scheduler job's body is fixed, while `applyUpdatesToInstances`, which a fixed body can do, replaces every node at once.

To replace the nodes now, and to see past runs:

```bash
gcloud run jobs execute node-replacement --region=us-central1 --project=walkie-talkie-relay
```

```bash
gcloud run jobs executions list --job=node-replacement --region=us-central1 --project=walkie-talkie-relay
```

After a replacement, `gcloud compute ssh` refuses the node's new host key; see Everyday commands. The container image (Node, Caddy and their Debian base) is only rebuilt by a deploy of a new commit; this replaces the OS underneath it.

## The account API and overandout.app

```
iPhone, watch ──HTTPS──▶ overandout.app (Firebase Hosting) ──/v2/*──▶ Cloud Run "api" ──▶ Firestore
                          /i/<code>, apple-app-site-association,       scales to zero      users, friends, invites,
                          home, privacy, support (web/public)                             blocks, reports, sessions
```

- **Sessions**: the API signs Ed25519 JWTs with `session-signing-key` (only the `account-api` service account can read it). Relay nodes verify them with `session-public-keys`, with no session store.
- **Sign in with Apple**: `apple-siwa-key` (the .p8 from the developer portal) lets the API revoke a user's Apple tokens when they delete their account.
- **Reports** log a `[report]` line; an alert policy emails `ALERT_EMAIL`. Read them in the Firestore console (`reports`).

Once, after the relay's setup (the Firebase step also needs Firebase added to the project in its console, which accepts its terms):

```bash
deploy/gcp/setup-api.sh
```

```bash
deploy/gcp/deploy-web.sh setup
```

`setup-api.sh` enables Cloud Run, creates the `account-api` service account, generates the session keys straight into Secret Manager, stores the Sign in with Apple key (`APPLE_SIWA_KEY_FILE`), adds the invites TTL policy, and creates the report alert. `deploy-web.sh setup` creates the Hosting site and the custom domain, and prints the DNS records to add at GoDaddy (`deploy-web.sh dns` shows their state).

To deploy the API (from committed code) and the site:

```bash
deploy/gcp/deploy-api.sh
```

```bash
deploy/gcp/deploy-web.sh
```

The site's apple-app-site-association gets the team ID from `APPLE_TEAM_ID` (or `APNS_TEAM_ID`), and the privacy and support pages get `SUPPORT_EMAIL`. During the Beta, set `TESTFLIGHT_URL` to the public TestFlight link (App Store Connect → TestFlight → an external group → Public Link) and redeploy the site: the invite page (`/i/<code>`) then offers "Join the beta on TestFlight" instead of "Coming soon to the App Store", which it shows while `TESTFLIGHT_URL` is empty. After adding a node or a new session key, redeploy the relay so nodes read `session-public-keys` again.

**Test Bot as an account** (for testing with one set of devices), with your gcloud credentials:

```bash
cd server && node tools/test-account.ts create
```

Then invite the bot from the iPhone app, copy the link, and run `node tools/test-account.ts accept <link>`. `node tools/bot.ts send` rings its first friend; `listen` waits to be rung. Its token is saved in `server/data/bot-token.json` (gitignored), never printed.

## Everyday commands

Use these flags on every command below:

```bash
--project=walkie-talkie-relay --zone=us-central1-a
```

| Task | Command |
| --- | --- |
| Nodes and their health | `gcloud compute instance-groups managed list-instances relay` |
| Relay logs | `gcloud compute ssh relay-1 -- sudo journalctl -u relay -n 100` |
| Revision a node serves | `curl https://relay-1.overandout.app/healthz` |
| Restart a node's container | `gcloud compute ssh relay-1 -- sudo systemctl restart relay` |
| Recreate a node | `gcloud compute instance-groups managed recreate-instances relay --instances=relay-1` |
| Relay state | `curl -H "Authorization: Bearer $SPIKE_TOKEN" https://relay-1.overandout.app/admin/status` |
| Rotate the relay token | new value in `config.sh` (`openssl rand -hex 24`), then `grep -o 'SPIKE_TOKEN="[^"]*"' deploy/gcp/config.sh \| cut -d'"' -f2 \| tr -d '\n' \| gcloud secrets versions add relay-token --data-file=-`, redeploy the relay, and destroy the old version (Secret Manager bills versions beyond 6) |
| API logs | `gcloud logging read 'resource.labels.service_name="api"' --limit=50` |
| API revision | `curl https://overandout.app/v2/health` |

Logs also go to Cloud Logging, in Logs Explorer under the VM instance.

A replaced node has new SSH host keys, and `gcloud compute ssh` refuses it ("REMOTE HOST IDENTIFICATION HAS CHANGED"). Remove the old entry, which is named after the instance ID in the error. gcloud then reads the new keys from the node's guest attributes, through Google's API:

```bash
ssh-keygen -R compute.INSTANCE_ID -f ~/.ssh/google_compute_known_hosts
```

## Local runs and tests

The server keeps a JSON store for local runs (`DATA_DIR`) and `npm test`. `npm run test:firestore` runs the Firestore store against the Firestore emulator. It needs `gcloud components install cloud-firestore-emulator` and Java 21 or later (`brew install openjdk`). To run a local relay against the real database as your gcloud account:

```bash
cd server && STORE=firestore FIRESTORE_AUTH=gcloud FIRESTORE_PROJECT=walkie-talkie-relay SPIKE_TOKEN=… node src/main.ts
```

## Costs

For the Beta, the one charge is the static IP, about $3.65 a month. One e2-micro and 30 GB of standard disk are free in us-central1, and a node uses 20 GB. Firestore's free quota is 50,000 reads and 20,000 writes a day, and a conversation costs about 2 reads and 3 writes. Artifact Registry (0.5 GB), Cloud Build (2,500 minutes a month) and uptime checks (1 million runs) stay in their free tiers. Secret Manager's free tier covers 6 active secret versions and there are 6 (a few cents a month beyond that). Cloud Run (2 million requests a month) and Firebase Hosting (10 GB stored, 360 MB a day served) stay free at Beta scale. Cloud Scheduler's first 3 jobs per billing account are free; there are 2 (`stats-daily`, `node-replacement-monthly`), and the Cloud Run jobs they start use a few minutes a day and a month, inside Cloud Run's free tier.

## Security notes

- Apps connect with their account's session token. An account can only ring its friends; the relay refuses other rings (`talk-refused`).
- The shared relay token (`SPIKE_TOKEN`) only reads the operator's diagnostics (`/admin/status`, `/admin/metrics`), which session tokens can't use. Every relay client is an account with a session token. To rotate it, see Everyday commands.
- Nodes read the relay token, the APNs key and the session public keys from Secret Manager at startup. Only the `relay-node` service account can read them. Only the `account-api` service account can read the session signing key and the Sign in with Apple key.
- The container runs as an unprivileged user with every capability dropped except binding ports 80 and 443.

## The Over&Out Ops dashboard

The product dashboard ([OPS_DASHBOARD_SPEC.md](../../OPS_DASHBOARD_SPEC.md)): a Cloud Run service `ops` behind Identity-Aware Proxy, the rolling job `stats-rolling` with the Canary, and nightly reports. In order, each with Steve's OK:

1. Console: the "Over&Out" OAuth consent screen and an IAP web client with the redirect URI `https://iap.googleapis.com/v1/oauth/clientIds/<client ID>:handleRedirect` (`setup-ops.sh`'s header has the settings); put the client's ID and secret in `config.sh` (`OPS_OAUTH_CLIENT_ID`, `OPS_OAUTH_CLIENT_SECRET`).
2. `node server/tools/test-account.ts canary` (with `TEST_BOT_USER_ID` set) makes the Canary; put its ID in `config.sh` as `CANARY_USER_ID`.
3. `deploy/gcp/setup-ops.sh`: the `ops-viewer` account, the `ops-stats-token` secret, the service behind IAP. Put the URL it prints in `config.sh` as `OPS_URL`.
4. `deploy/gcp/deploy-relay.sh` (about 2 minutes without the relay): the relay reads the token and leaves the Canary out of its live view.
5. `deploy/gcp/setup-stats.sh`: the `stats-rolling` job and its Scheduler job (the third free one), the bots' IDs for both jobs, TTL policies on `statsLive` and reports' `history`.
6. `deploy/gcp/ops-access.sh add <email>` (or `add group:<email>`) for each person.
7. `deploy/gcp/setup-telemetry.sh` (or `node deploy/gcp/telemetry-monitoring.ts apply` with `OPS_URL`): the link row on "Over&Out Beta", both links in every alert email, the Canary's charts.

8. `deploy/gcp/setup-ops-redirect.sh`: `ops.overandout.app` as a friendly address, a second Firebase Hosting site (`overandout-ops`, no files) that redirects every path to `OPS_URL` with a 302. Steve adds the CNAME it prints at GoDaddy; `setup-ops-redirect.sh dns` shows the certificate's progress. The dashboard stays on its `run.app` address behind IAP (a custom domain there would need a Cloud Run domain mapping, still preview, or a load balancer).

`deploy-api.sh` keeps the `ops` service and both stats jobs on the API's image. Locally: `OPS_LOCAL=1 STATS_LOCAL_DIR=<DATA_DIR> RELAY_NODES=http://localhost:8080 OPS_STATS_TOKEN=<the relay's> node server/src/ops-main.ts`, after `rolling-main.ts` with the same `STATS_LOCAL_DIR`.
