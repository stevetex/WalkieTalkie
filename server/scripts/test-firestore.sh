#!/usr/bin/env bash
# Runs test/firestore.test.ts against a throwaway Firestore emulator.
# Needs the gcloud CLI with the emulator (gcloud components install cloud-firestore-emulator)
# and Java 21 or later. Homebrew's keg-only openjdk is used if it's installed.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${FIRESTORE_EMULATOR_PORT:-8085}"
if [ -z "${FIRESTORE_EMULATOR_HOST:-}" ]; then
  export PATH="$HOME/google-cloud-sdk/bin:$PATH"
  if [ -x /opt/homebrew/opt/openjdk/bin/java ]; then export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"; fi
  log="$(mktemp)"
  # Job control gives the emulator its own process group, so the Java process gcloud
  # starts under it is stopped along with it.
  set -m
  gcloud emulators firestore start --host-port="localhost:$PORT" >"$log" 2>&1 &
  emulator=$!
  set +m
  trap 'kill -- "-$emulator" 2>/dev/null; rm -f "$log"' EXIT
  for _ in $(seq 1 60); do
    if curl -sf "http://localhost:$PORT" >/dev/null 2>&1; then break; fi
    if ! kill -0 "$emulator" 2>/dev/null; then cat "$log"; exit 1; fi
    sleep 0.5
  done
  export FIRESTORE_EMULATOR_HOST="localhost:$PORT"
fi
node --test --test-timeout=20000 test/firestore.test.ts
