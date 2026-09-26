# Hosting the relay on Google Cloud

The relay runs on **relay nodes** (option E in the feasibility doc): small VMs in a managed instance group on Container-Optimized OS (COS), each running one container. Server data (devices and metrics timelines) lives in Firestore, so a node holds nothing that matters. Restarts, OS updates and replacing a failed node are automatic.

```
watch ──HTTPS──▶ relay-1.overandout.app ──▶ [ Caddy :443 ──▶ relay 127.0.0.1:8080 ] ──▶ Firestore (us-central1)
                  static IP, Standard tier     one container on COS, e2-micro           devices, timelines
                                               /data: certificates (stateful disk)      Secret Manager: token, APNs key
```

- **The image** (`server/Dockerfile`): Node 24 and Caddy. Caddy gets and renews Let's Encrypt certificates and proxies to the relay with streaming (`flush_interval -1`). Both run as an unprivileged user. It's built by Cloud Build from committed code, tagged with the commit, and stored in Artifact Registry.
- **The node** (`relay-node.cloud-init.yaml`): cloud-init mounts the data disk, opens ports 80 and 443 in COS's host firewall, and runs the container as the systemd service `relay`. The image and settings come from instance metadata.
- **The group** (`relay`, us-central1-a) is stateful. Each node keeps its name, its data disk and, per node, its static IP and hostnames, across replacements. Autohealing recreates a node that fails `relay-health` (HTTP port 80 `/healthz`, through Caddy to the relay) three times in a row.
- **Secrets**: the relay token (`relay-token`) and the APNs key (`apns-key`) are in Secret Manager. Only the nodes' service account (`relay-node`) can read them. The image, template and metadata hold none.

## Setting up (once)

Fill in `config.sh` from `config.example.sh` (see below), then:

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
2. `setup-relay.sh` creates the image repository, copies the relay token and APNs key into Secret Manager, and creates the health check.
3. `deploy-relay.sh`, the first time, builds the image and creates the instance group with no nodes.

Then add a node. Its hostnames need DNS A records pointing at its static IP first, or Caddy can't get certificates:

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

It builds the image for `HEAD` (about 30 s) unless that commit is already built, and creates an instance template `relay-<commit>`. Then it replaces the nodes one at a time. Each node gets SIGTERM, lets conversations in progress finish for up to 45 s, writes its buffered metrics, and comes back with the same name, IP and certificates, on the newest COS. A deploy is also how nodes pick up OS updates. With one node, a deploy means about 2 minutes of downtime.

To roll back, deploy an earlier commit: `deploy/gcp/deploy-relay.sh <commit>`.

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
| Relay state | `curl -H "Authorization: Bearer $SPIKE_TOKEN" https://relay-1.overandout.app/v1/status` |

Logs also go to Cloud Logging, in Logs Explorer under the VM instance.

## Local runs and tests

The server keeps a JSON store for local runs (`DATA_DIR`) and `npm test`. `npm run test:firestore` runs the Firestore store against the Firestore emulator. It needs `gcloud components install cloud-firestore-emulator` and Java 21 or later (`brew install openjdk`). To run a local relay against the real database as your gcloud account:

```bash
cd server && STORE=firestore FIRESTORE_AUTH=gcloud FIRESTORE_PROJECT=walkie-talkie-relay SPIKE_TOKEN=… node src/main.ts
```

## Costs

For the Beta, the one charge is the static IP, about $3.65 a month. One e2-micro and 30 GB of standard disk are free in us-central1, and a node uses 20 GB. Firestore's free quota is 50,000 reads and 20,000 writes a day, and a conversation costs about 2 reads and 3 writes. Artifact Registry (0.5 GB), Cloud Build (2,500 minutes a month), Secret Manager (6 versions) and uptime checks (1 million runs) all stay in their free tiers.

# Legacy: the hand-built VM

Everything below describes the single `walkie-relay` VM (Debian, Caddy and a systemd service, deployed with `deploy.sh`), which ran the relay until relay-1 took over its IP. It's kept until that VM is deleted.

## What you need

- A Google Cloud project with billing enabled. The free tier still requires a billing account.
- The [Google Cloud CLI](https://cloud.google.com/sdk/docs/install), signed in with `gcloud auth login`.
- A domain whose DNS you control, for example `walkie.stevetex.com`.

## One-time setup

1. **Configure.** Copy `config.example.sh` to `config.sh`, which is gitignored, and fill in:
   - `PROJECT_ID`
   - `DOMAIN`
   - `ACME_EMAIL`
   - `SPIKE_TOKEN`, generated with the command below

   ```bash
   openssl rand -hex 24
   ```

   Leave the `APNS_*` settings empty until your Apple Developer Program membership is active.

2. **Create the VM.** The script reserves a static IP, opens ports 80 and 443, and creates the VM. It prints the IP address at the end.

   ```bash
   deploy/gcp/create-vm.sh
   ```

3. **Point DNS at it.** At your DNS provider, add an A record from `DOMAIN` to that IP. Then check it resolves:

   ```bash
   dig +short walkie.stevetex.com
   ```

4. **Deploy.** This installs Caddy and Node.js 24, installs the server and starts it. It then waits until `https://DOMAIN/healthz` answers, which takes a little longer on the first run while Caddy gets the certificate.

   ```bash
   deploy/gcp/deploy.sh
   ```

5. **Point the clients at it.**
   - **Watch:** in `watch/Config/Local.xcconfig`, set `SPIKE_SERVER_HOST` to the domain, without `https://`, and `SPIKE_TOKEN` to the same token.
   - **Bot and report tools:** `export SPIKE_SERVER=https://walkie.stevetex.com SPIKE_TOKEN=…`

## Redeploying

Commit your changes, then run `deploy/gcp/deploy.sh` again. It ships only committed code from `server/`, and warns if `server/` has uncommitted changes. Each deploy goes into a new directory under `/opt/walkie/releases`, and the last five are kept.

To roll back, point `/opt/walkie/current` at an earlier release on the VM and restart the service.

## Adding APNs when your membership is active

1. Create the `.p8` key in the developer portal.
2. Fill in `APNS_KEY_FILE`, `APNS_KEY_ID`, `APNS_TEAM_ID` and `APNS_BUNDLE_ID` in `config.sh`.
3. Run `deploy.sh` again. The key is copied to `/etc/walkie/apns.p8`, readable only by root and the service.

Watches built with `SPIKE_PUSH_MODE = none` keep working alongside push-enabled ones.

## Everyday commands

Use these flags on every command below:

```bash
--project=YOUR_PROJECT --zone=us-central1-a
```

| Task | Command |
| --- | --- |
| Follow server logs | `gcloud compute ssh walkie-relay -- sudo journalctl -u walkie -f` |
| Caddy and certificate logs | `gcloud compute ssh walkie-relay -- sudo journalctl -u caddy -n 100` |
| Restart the server | `gcloud compute ssh walkie-relay -- sudo systemctl restart walkie` |
| Relay state | `curl -H "Authorization: Bearer $SPIKE_TOKEN" https://DOMAIN/v1/status` |
| Stop the VM (the IP is still billed while reserved) | `gcloud compute instances stop walkie-relay` |

## Staying in the free tier

- **Machine and disk:** keep `e2-micro` in `us-west1`, `us-central1` or `us-east1`, with a standard disk of 30 GB or less. `create-vm.sh` sets all of these.
- **Traffic:** the VM uses the Standard network tier, which includes 200 GiB of free outbound traffic a month. Opus audio at about 3 KB/s per stream won't come close.
- **The one charge:** the static IP, at about $0.005 an hour. Set a small budget alert in Billing, for example $10 a month, to catch surprises.

## Tearing it down

```bash
gcloud compute instances delete walkie-relay --zone=us-central1-a
gcloud compute addresses delete walkie-relay-ip --region=us-central1
gcloud compute firewall-rules delete walkie-web
```

Add `--project=YOUR_PROJECT` to each, then remove the DNS record.

## Security notes

- Every API and relay call needs `SPIKE_TOKEN`. It's a shared secret for the spike; real accounts (Sign in with Apple) replace it later.
- Secrets live in `/etc/walkie`, readable only by root and the `walkie` service. A later step can move them to Secret Manager.
- The Node.js download is checked against the release's published SHA-256 sums.
