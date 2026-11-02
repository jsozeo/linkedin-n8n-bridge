#!/usr/bin/env bash
# Publish the LinkedIn selector registry to S3.
#
#   ./test-server/push-selectors.sh
#
# The extension refetches it on its next poll cycle (10-minute TTL, or
# immediately via the `selectors_refresh` command), so a LinkedIn DOM change
# is fixed by editing extension/selectors.json and running this — no rebuild,
# no reload. Bump `version` in the JSON so you can tell which document is live.
set -euo pipefail

REGION=eu-west-3
PROFILE=cursor-admin
BUCKET=sm-bridge-test-captures-519041483453

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/extension/selectors.json"
[ -f "$src" ] || { echo "missing $src"; exit 1; }

node -e 'const d=require(process.argv[1]); if(!d.linkedin) throw new Error("no linkedin key"); if(!d.version) throw new Error("no version"); console.log("version:",d.version)' "$src"

aws s3 cp "$src" "s3://$BUCKET/selectors.json" \
  --profile "$PROFILE" --region "$REGION" --content-type application/json --cache-control no-store

echo "pushed selectors.json -> s3://$BUCKET/selectors.json"
echo "served at: <function-url>/selectors"
