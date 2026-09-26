#!/usr/bin/env bash
# Adds a node to the relay instance group, with the stateful settings it keeps across
# replacements: its data disk, and optionally a reserved static IP and the hostnames Caddy
# gets certificates for.
#
#   deploy/gcp/add-node.sh relay-1 --ip walkie-relay-ip --hostnames "relay-1.overandout.app walkie.example.com"
#   deploy/gcp/add-node.sh relay-canary          (ephemeral IP, plain HTTP, disk deleted with it)
#
# DNS for each hostname must already point at the IP, or Caddy can't get certificates.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source-path=SCRIPTDIR source=config.example.sh
. "$here/config.sh"

gc() { gcloud --project="$PROJECT_ID" --quiet "$@"; }

node=${1:?usage: add-node.sh NAME [--ip ADDRESS_NAME] [--hostnames "HOST ..."]}
shift
ip_name="" hostnames=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ip) ip_name=$2; shift 2 ;;
    --hostnames) hostnames=$2; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

args=()
if [ -n "$ip_name" ]; then
  ip=$(gc compute addresses describe "$ip_name" --region="$REGION" --format='value(address)')
  users=$(gc compute addresses describe "$ip_name" --region="$REGION" --format='value(users)')
  if [ -n "$users" ]; then
    echo "$ip_name ($ip) is still attached to $users. Detach it first." >&2
    exit 1
  fi
  args+=(--stateful-external-ip="address=$ip,interface-name=nic0,auto-delete=never")
  args+=(--stateful-disk=device-name=relay-data,auto-delete=never)
else
  # A test node: its disk goes when the node is deleted.
  args+=(--stateful-disk=device-name=relay-data,auto-delete=on-permanent-instance-deletion)
fi
if [ -n "$hostnames" ]; then args+=(--stateful-metadata="relay-hostnames=$hostnames"); fi

echo "Adding $node to the relay group…"
gc compute instance-groups managed create-instance relay --zone="$ZONE" --instance="$node" "${args[@]}"
gc compute instance-groups managed wait-until relay --zone="$ZONE" --stable --timeout=900
gc compute instances describe "$node" --zone="$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)'
