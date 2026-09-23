# Hosting the spike server on Google Cloud

This deploys the relay and push server to a single e2-micro VM on Google Cloud. The VM, disk and traffic fit inside Google's free tier. The only charge is the static IPv4 address, about $3.65 a month.

```
watch ──HTTPS/WSS──▶ Caddy :443 (Let's Encrypt) ──▶ node server 127.0.0.1:8080
                     └────────── e2-micro VM, Debian 13 ──────────┘
```

- **Caddy** handles HTTPS, gets and renews certificates automatically, and proxies WebSockets.
- **The server** runs as a locked-down `walkie` system service. It listens only on localhost.
- **The firewall** opens only ports 80 and 443, plus SSH through the default network's rule. Port 80 is used only for Let's Encrypt's check.

See the feasibility doc's Hosting section for why Google Cloud was chosen, and for the Cloud Run plan once traffic grows.

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
