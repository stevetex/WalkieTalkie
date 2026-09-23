#!/usr/bin/env bash
# One-time setup: creates the free-tier VM, its static IP and the HTTPS firewall rule.
# Safe to re-run; existing resources are left alone.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
if [ ! -f "$here/config.sh" ]; then
  echo "Copy config.example.sh to config.sh and fill it in first." >&2
  exit 1
fi
# shellcheck source-path=SCRIPTDIR source=config.example.sh
. "$here/config.sh"

case "$REGION" in
  us-west1 | us-central1 | us-east1) ;;
  *) echo "Warning: $REGION isn't an e2-micro free-tier region; the VM will be billed." >&2 ;;
esac

gc() { gcloud --project="$PROJECT_ID" --quiet "$@"; }

echo "Enabling the Compute Engine API (first run can take a minute)…"
gc services enable compute.googleapis.com

ip_name="$VM_NAME-ip"
if ! gc compute addresses describe "$ip_name" --region="$REGION" >/dev/null 2>&1; then
  echo "Reserving static IP $ip_name…"
  # Standard network tier: its 200 GiB/month of free egress beats Premium's 1 GB.
  gc compute addresses create "$ip_name" --region="$REGION" --network-tier=STANDARD
fi
ip=$(gc compute addresses describe "$ip_name" --region="$REGION" --format='value(address)')

if ! gc compute firewall-rules describe walkie-web >/dev/null 2>&1; then
  echo "Opening ports 80 and 443…"
  # 80 is only for Let's Encrypt's HTTP challenge; Caddy redirects it to HTTPS.
  gc compute firewall-rules create walkie-web \
    --network=default --direction=INGRESS --allow=tcp:80,tcp:443 \
    --target-tags=walkie-web --source-ranges=0.0.0.0/0 \
    --description="HTTPS for the walkie-talkie relay"
fi

if ! gc compute instances describe "$VM_NAME" --zone="$ZONE" >/dev/null 2>&1; then
  echo "Creating $VM_NAME (e2-micro, Debian 13)…"
  # e2-micro + up to 30 GB standard persistent disk stay inside the free tier.
  gc compute instances create "$VM_NAME" \
    --zone="$ZONE" --machine-type=e2-micro \
    --image-family=debian-13 --image-project=debian-cloud \
    --boot-disk-size=30GB --boot-disk-type=pd-standard \
    --network-tier=STANDARD --address="$ip" --tags=walkie-web
fi

cat <<EOF

VM ready at $ip.

Next:
  1. At your DNS provider, add an A record:  $DOMAIN -> $ip
  2. Wait until it resolves:                  dig +short $DOMAIN
  3. Deploy the server:                       $here/deploy.sh
EOF
