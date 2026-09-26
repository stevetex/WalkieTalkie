#!/usr/bin/env bash
# Runs Caddy and the relay side by side. If either exits, the other is stopped and the
# container exits, so systemd on the VM restarts it. On SIGTERM the relay stops first
# (it drains conversations for up to DRAIN_MS and writes buffered metrics), then Caddy.
#
#   RELAY_HOSTNAMES  space-separated names Caddy gets certificates for, such as
#                    "relay-1.overandout.app walkie.cypressoakstudios.com". Empty serves
#                    plain HTTP on port 80 only (a test node with no DNS name).
#   ACME_EMAIL       optional; Let's Encrypt's expiry notices go here.
#
# Certificates live in /data/caddy (XDG_DATA_HOME), the node's persistent disk.
# With --validate, it only checks the generated Caddyfile (the image build runs this).
set -euo pipefail

caddyfile=/tmp/Caddyfile
{
  printf '{\n\tadmin off\n'
  if [ -n "${ACME_EMAIL:-}" ]; then printf '\temail %s\n' "$ACME_EMAIL"; fi
  printf '}\n\n'
  # Health checks come over plain HTTP on port 80 and go through to the relay, so they
  # check both processes. Everything else on port 80 redirects to HTTPS (ACME's HTTP
  # challenge is answered before this).
  printf 'http:// {\n\thandle /healthz {\n\t\treverse_proxy 127.0.0.1:8080\n\t}\n'
  if [ -n "${RELAY_HOSTNAMES:-}" ]; then
    printf '\thandle {\n\t\tredir https://{host}{uri} permanent\n\t}\n}\n\n'
    # flush_interval -1: pass the relay's streaming responses (the watch's audio
    # downlink) through immediately instead of buffering them.
    printf '%s {\n\treverse_proxy 127.0.0.1:8080 {\n\t\tflush_interval -1\n\t}\n}\n' "$(echo "$RELAY_HOSTNAMES" | tr ' ' ',' | sed 's/,,*/, /g')"
  else
    printf '\thandle {\n\t\treverse_proxy 127.0.0.1:8080 {\n\t\t\tflush_interval -1\n\t\t}\n\t}\n}\n'
  fi
} >"$caddyfile"

if [ "${1:-}" = --validate ]; then exec caddy validate --config "$caddyfile" --adapter caddyfile; fi

caddy run --config "$caddyfile" --adapter caddyfile &
caddy=$!
node /app/src/main.ts &
relay=$!

stop() {
  kill -TERM "$relay" 2>/dev/null || true
  wait "$relay" 2>/dev/null || true
  kill -TERM "$caddy" 2>/dev/null || true
  wait "$caddy" 2>/dev/null || true
  exit 0
}
trap stop TERM INT

# Returns when either process exits (or a trapped signal arrives, which runs stop).
set +e
wait -n "$caddy" "$relay"
status=$?
set -e
echo "[entrypoint] $( kill -0 "$relay" 2>/dev/null && echo caddy || echo relay ) exited ($status); stopping" >&2
kill -TERM "$caddy" "$relay" 2>/dev/null || true
wait
exit 1
