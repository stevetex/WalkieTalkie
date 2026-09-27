# Hosting the relay on Google Cloud

The relay runs on **relay nodes** (option E in the feasibility doc): small VMs in a managed instance group on Container-Optimized OS (COS), each running one container. Server data (devices and metrics timelines) lives in Firestore, so a node holds nothing that matters. Restarts, OS updates and replacing a failed node are automatic.

```
watch ──HTTPS──▶ relay-1.overandout.app ──▶ [ Caddy :443 ──▶ relay 127.0.0.1:8080 ] ──▶ Firestore (us-central1)
                  static IP, Standard tier     one container on COS, e2-micro           devices, timelines
                                               /data: certificates (stateful disk)      Secret Manager: token, APNs key
```

- **The image** (`server/Dockerfile`): Node 24 and Caddy. Caddy gets and renews certificates from Google Trust Services (Google Cloud's free Public CA, whose roots Apple trusts; the watch took ~1 s longer per connection to evaluate Let's Encrypt's newer chain) and proxies to the relay with streaming (`flush_interval -1`). Both run as an unprivileged user. It's built by Cloud Build from committed code, tagged with the commit, and stored in Artifact Registry.
- **The node** (`relay-node.cloud-init.yaml`): cloud-init mounts the data disk, opens ports 80 and 443 in COS's host firewall, and runs the container as the systemd service `relay`. The image and settings come from instance metadata.
- **The group** (`relay`, us-central1-a) is stateful. Each node keeps its name, its data disk and, per node, its static IP and hostnames, across replacements. Autohealing recreates a node that fails `relay-health` (HTTP port 80 `/healthz`, through Caddy to the relay) three times in a row.
- **Secrets**: the relay token (`relay-token`), the APNs key (`apns-key`) and the Public CA account key (`acme-eab`) are in Secret Manager. Only the nodes' service account (`relay-node`) can read them. The image, template and metadata hold none.

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

For the Beta, the one charge is the static IP, about $3.65 a month. One e2-micro and 30 GB of standard disk are free in us-central1, and a node uses 20 GB. Firestore's free quota is 50,000 reads and 20,000 writes a day, and a conversation costs about 2 reads and 3 writes. Artifact Registry (0.5 GB), Cloud Build (2,500 minutes a month), Secret Manager (6 versions) and uptime checks (1 million runs) all stay in their free tiers.

## Security notes

- Every API and relay call needs the shared relay token (`SPIKE_TOKEN`). It stands in for real accounts (Sign in with Apple), which replace it later.
- Nodes read the relay token and the APNs key from Secret Manager at startup. Only the `relay-node` service account can read them.
- The container runs as an unprivileged user with every capability dropped except binding ports 80 and 443.
