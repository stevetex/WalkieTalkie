#!/usr/bin/env bash
# Deploys a relay image to the relay instance group (option E). Builds the image if
# needed, creates an instance template for it, then either creates the group (first run,
# with no nodes; add them with add-node.sh) or replaces the nodes one at a time. Each
# node drains for up to 45 s before it's replaced, and comes back with the same name, IP
# and certificate disk, on the newest Container-Optimized OS.
#
#   deploy/gcp/deploy-relay.sh [commit]     (default: HEAD)
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
# shellcheck source-path=SCRIPTDIR source=config.example.sh
. "$here/config.sh"

gc() { gcloud --project="$PROJECT_ID" --quiet "$@"; }
group=relay

image=$("$here/build-image.sh" "$@")
rev=${image##*:}
template="relay-$rev"

umask 077
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
# The container's settings. No secrets: the relay reads those from Secret Manager.
{
  echo "SPIKE_TOKEN_SECRET=relay-token"
  # Certificates from Google Trust Services (see server/container/entrypoint.sh).
  echo "ACME_EAB_SECRET=acme-eab"
  # Prototype: the prefetch push for the watch's notification service extension
  # (prefetchAlert in server/src/apns.ts). PREFETCH_PUSH_MS=0 in config.sh turns it off.
  echo "PREFETCH_PUSH_MS=${PREFETCH_PUSH_MS:-3000}"
  # Public CA refuses ACME accounts without a contact address.
  acme_email=${ACME_EMAIL:-${ALERT_EMAIL:-}}
  if [ -n "$acme_email" ]; then echo "ACME_EMAIL=$acme_email"; fi
  # Accounts' session tokens (setup-api.sh creates the public keys).
  if gc secrets describe session-public-keys >/dev/null 2>&1; then echo "SESSION_PUBLIC_KEYS_SECRET=session-public-keys"; fi
  if [ -n "$APNS_KEY_FILE" ]; then
    echo "APNS_KEY_SECRET=apns-key"
    echo "APNS_KEY_ID=$APNS_KEY_ID"
    echo "APNS_TEAM_ID=$APNS_TEAM_ID"
    echo "APNS_BUNDLE_ID=$APNS_BUNDLE_ID"
  fi
} >"$stage/relay.env"
# The node setup from the same commit as the image.
git -C "$repo" show "$rev:deploy/gcp/relay-node.cloud-init.yaml" >"$stage/cloud-init.yaml"

if ! gc compute instance-templates describe "$template" >/dev/null 2>&1; then
  echo "Creating instance template ${template}…"
  # e2-micro on a standard disk stays in the free tier (one per billing account). The
  # data disk holds Caddy's certificates; the group keeps it across replacements. Guest
  # attributes publish each new node's SSH host keys, so gcloud compute ssh trusts a
  # replaced node instead of refusing its changed key.
  gc compute instance-templates create "$template" \
    --machine-type=e2-micro \
    --image-family=cos-stable --image-project=cos-cloud \
    --boot-disk-size=10GB --boot-disk-type=pd-standard \
    --create-disk=device-name=relay-data,size=10GB,type=pd-standard,auto-delete=no \
    --network-tier=STANDARD --tags=walkie-web \
    --service-account="relay-node@$PROJECT_ID.iam.gserviceaccount.com" --scopes=cloud-platform \
    --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
    --metadata=relay-image="$image",google-logging-enabled=true,google-monitoring-enabled=true,enable-guest-attributes=TRUE \
    --metadata-from-file=user-data="$stage/cloud-init.yaml",relay-env="$stage/relay.env"
fi

if ! gc compute instance-groups managed describe "$group" --zone="$ZONE" >/dev/null 2>&1; then
  echo "Creating the $group instance group (no nodes yet)…"
  # Stateful: each node keeps its data disk and, per node (add-node.sh), its static IP
  # and hostnames. Autohealing recreates a node that fails relay-health for 30 s, after
  # giving a new node 5 minutes to boot, pull the image and get certificates.
  gc compute instance-groups managed create "$group" --zone="$ZONE" --template="$template" --size=0 \
    --health-check=relay-health --initial-delay=300 \
    --stateful-disk=device-name=relay-data,auto-delete=never \
    --update-policy-type=opportunistic --update-policy-max-surge=0 --update-policy-max-unavailable=1 \
    --update-policy-replacement-method=recreate --update-policy-minimal-action=replace
  echo "Done. Add nodes with deploy/gcp/add-node.sh."
  exit 0
fi

echo "Rolling $group to $template, one node at a time…"
gc compute instance-groups managed rolling-action start-update "$group" --zone="$ZONE" \
  --version=template="$template" --type=proactive --max-surge=0 --max-unavailable=1 \
  --replacement-method=recreate --minimal-action=replace
gc compute instance-groups managed wait-until "$group" --zone="$ZONE" --stable --timeout=1200

# Every node with hostnames should now serve this revision over HTTPS.
status=0
for node in $(gc compute instance-groups managed list-instances "$group" --zone="$ZONE" --format='value(name)'); do
  host=$(gc compute instances describe "$node" --zone="$ZONE" \
    --format='value(metadata.items.filter(key:relay-hostnames).extract(value).flatten())' | awk '{print $1}')
  [ -n "$host" ] || continue
  if curl -fsS --max-time 10 "https://$host/healthz" | grep -q "\"revision\":\"$rev\""; then
    echo "$node: https://$host serves $rev"
  else
    echo "$node: https://$host isn't serving $rev yet" >&2
    status=1
  fi
done
exit $status
