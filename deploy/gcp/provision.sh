#!/usr/bin/env bash
# Runs on the VM as root, called by deploy.sh with the upload directory. Idempotent:
# installs Caddy and Node.js if needed, installs the new release, writes the config
# and restarts the service.
set -euo pipefail

src=${1:?usage: provision.sh <upload-dir>}
# shellcheck source=/dev/null
. "$src/site.env" # DOMAIN, ACME_EMAIL
node_major=24     # current LTS; the server needs 24+ (type stripping, import.meta.main)
export DEBIAN_FRONTEND=noninteractive

# Caddy terminates TLS (automatic Let's Encrypt certificates) and proxies WebSockets.
if ! command -v caddy >/dev/null 2>&1; then
  apt-get update -q
  apt-get install -y -q caddy curl xz-utils ca-certificates
fi

# Node.js from the official build (Debian 13's nodejs is too old), checked against
# the release's published SHA-256 sums.
dist="https://nodejs.org/dist/latest-v$node_major.x"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL "$dist/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
tarball=$(awk '$2 ~ /-linux-x64\.tar\.xz$/ { print $2 }' "$work/SHASUMS256.txt")
version=${tarball#node-}
version=${version%-linux-x64.tar.xz}
if [ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "$version" ]; then
  echo "Installing Node.js $version…"
  curl -fsSL "$dist/$tarball" -o "$work/$tarball"
  (cd "$work" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c --quiet -)
  rm -rf /opt/node
  mkdir -p /opt/node
  tar -xJf "$work/$tarball" -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
fi

# Service account and configuration. Secrets are readable only by root and the service.
id walkie >/dev/null 2>&1 || useradd --system --home-dir /var/lib/walkie --shell /usr/sbin/nologin walkie
install -d -o root -g walkie -m 750 /etc/walkie
install -o root -g walkie -m 640 "$src/walkie.env" /etc/walkie/walkie.env
if [ -f "$src/apns.p8" ]; then
  install -o root -g walkie -m 640 "$src/apns.p8" /etc/walkie/apns.p8
else
  rm -f /etc/walkie/apns.p8
fi

# Each deploy is a new release directory; "current" points at the live one.
release="/opt/walkie/releases/$(date -u +%Y%m%d%H%M%S)-$(cat "$src/REVISION")"
mkdir -p "$release"
tar -xzf "$src/server.tgz" -C "$release"
ln -sfn "$release" /opt/walkie/current
# Keep the five most recent releases for quick rollback.
find /opt/walkie/releases -mindepth 1 -maxdepth 1 -type d | sort -r | tail -n +6 | xargs -r rm -rf

cat >/etc/systemd/system/walkie.service <<'EOF'
[Unit]
Description=Walkie-Talkie relay and push server
After=network-online.target
Wants=network-online.target

[Service]
User=walkie
Group=walkie
WorkingDirectory=/opt/walkie/current/server
EnvironmentFile=/etc/walkie/walkie.env
ExecStart=/usr/local/bin/node src/main.ts
Restart=always
RestartSec=2
# Registered devices and metrics live in /var/lib/walkie.
StateDirectory=walkie
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

{
  # The ACME contact email is optional; without it there are no expiry notices.
  if [ -n "$ACME_EMAIL" ]; then printf '{\n\temail %s\n}\n\n' "$ACME_EMAIL"; fi
  # flush_interval -1: pass the relay's streaming responses (the watch's audio
  # downlink) through immediately instead of buffering them.
  printf '%s {\n\treverse_proxy 127.0.0.1:8080 {\n\t\tflush_interval -1\n\t}\n}\n' "$DOMAIN"
} >/etc/caddy/Caddyfile

systemctl daemon-reload
systemctl enable --quiet walkie caddy
systemctl restart walkie
systemctl reload caddy 2>/dev/null || systemctl restart caddy

rm -rf "$src"
sleep 1
systemctl --no-pager --lines=5 status walkie
