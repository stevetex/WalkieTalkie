#!/usr/bin/env bash
# Builds the relay container image from the committed server/ code with Cloud Build and
# pushes it to Artifact Registry, tagged with the commit. Skips the build if that tag
# already exists. Prints the image name last.
#
#   deploy/gcp/build-image.sh [commit]     (default: HEAD)
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
# shellcheck source-path=SCRIPTDIR source=config.example.sh
. "$here/config.sh"

rev=$(git -C "$repo" rev-parse --short "${1:-HEAD}")
image="$REGION-docker.pkg.dev/$PROJECT_ID/relay/relay:$rev"
gc() { gcloud --project="$PROJECT_ID" --quiet "$@"; }

if [ -z "${1:-}" ] && ! git -C "$repo" diff --quiet HEAD -- server; then
  echo "Note: server/ has uncommitted changes; building the last commit ($rev)." >&2
fi

if gc artifacts docker images describe "$image" >/dev/null 2>&1; then
  echo "Image for $rev already built." >&2
  echo "$image"
  exit 0
fi

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
# Only committed code: server/ becomes the build context's root.
git -C "$repo" archive "$rev:server" | tar -x -C "$stage"
cat >"$stage/cloudbuild.yaml" <<'YAML'
steps:
  - name: gcr.io/cloud-builders/docker
    args: [build, --pull, --build-arg, "REVISION=${_REVISION}", -t, "${_IMAGE}", .]
images: ["${_IMAGE}"]
options:
  logging: CLOUD_LOGGING_ONLY
YAML

echo "Building $image with Cloud Build…" >&2
gc builds submit "$stage" --region="$REGION" --config="$stage/cloudbuild.yaml" \
  --substitutions="_IMAGE=$image,_REVISION=$rev" >&2
echo "$image"
