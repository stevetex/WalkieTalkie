#!/usr/bin/env bash
# Runs Caddy and the relay side by side. If either exits, the other is stopped and the
# container exits, so systemd on the VM restarts it. On SIGTERM the relay stops first
# (it drains conversations for up to DRAIN_MS and writes buffered metrics), then Caddy.
#
#   RELAY_HOSTNAMES  space-separated names Caddy gets certificates for, such as
#                    "relay-1.overandout.app walkie.cypressoakstudios.com". Empty serves
#                    plain HTTP on port 80 only (a test node with no DNS name).
#   ACME_EMAIL       optional; the certificate authority's expiry notices go here.
#   ACME_EAB_SECRET  Secret Manager secret holding a Google Trust Services external
#                    account key (JSON with keyId and b64MacKey). With it, certificates
#                    come from Google Trust Services; without it, from Let's Encrypt.
#                    (ACME_EAB_KEY_ID and ACME_EAB_MAC_KEY set the key directly.)
#
# Certificates live in /data/caddy (XDG_DATA_HOME), the node's persistent disk.
# With --validate, it only checks the generated Caddyfile (the image build runs this).
set -euo pipefail

eab_key_id=${ACME_EAB_KEY_ID:-} eab_mac_key=${ACME_EAB_MAC_KEY:-}
if [ -z "$eab_key_id" ] && [ -n "${ACME_EAB_SECRET:-}" ]; then
  # A failure here stops the container rather than falling back to Let's Encrypt.
  eab=$(node /app/src/secrets.ts "$ACME_EAB_SECRET" keyId b64MacKey)
  read -r eab_key_id eab_mac_key <<<"$eab"
  [ -n "$eab_mac_key" ] || { echo "[entrypoint] $ACME_EAB_SECRET has no keyId/b64MacKey" >&2; exit 1; }
fi
if [ -n "$eab_key_id" ] && [ -z "${ACME_EMAIL:-}" ]; then
  echo "[entrypoint] Google Trust Services needs ACME_EMAIL (its accounts must have a contact)" >&2
  exit 1
fi

# The Caddyfile holds the account key, so only this user can read it.
umask 077
caddyfile=/tmp/Caddyfile
rm -f "$caddyfile"
{
  # HTTP/3 is off: it needs UDP 443, which the firewall doesn't open.
  printf '{\n\tadmin off\n\tservers {\n\t\tprotocols h1 h2\n\t}\n'
  if [ -n "${ACME_EMAIL:-}" ]; then printf '\temail %s\n' "$ACME_EMAIL"; fi
  # Google Trust Services (Google Cloud's Public CA, free). Its roots are in Apple's trust
  # store; the watch took ~1 s to evaluate Let's Encrypt's YE2 chain, whose Root YE isn't
  # (run 27 in the feasibility doc). The key is only used to register the ACME account,
  # which Caddy then keeps on the node's disk.
  if [ -n "$eab_key_id" ]; then
    printf '\tcert_issuer acme https://dv.acme-v02.api.pki.goog/directory {\n\t\teab %s %s\n\t}\n' "$eab_key_id" "$eab_mac_key"
  fi
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
