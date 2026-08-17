#!/usr/bin/env bash
# Regenerate an extractor's EXTRACT_JS from the local source and upload it to
# S3 so the next extension poll runs the fixed parser WITHOUT a reload.
#
#   ./test-server/push-extractor.sh linkedin.posts
#
# The kind maps to extension/src/extractors/<platform>/<type>.js
set -euo pipefail

KIND=${1:-linkedin.posts}
REGION=eu-west-3
PROFILE=cursor-admin
BUCKET=sm-bridge-test-captures-519041483453

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
platform="${KIND%%.*}"
type="${KIND#*.}"
src="$root/extension/src/extractors/${platform}/${type}.js"
[ -f "$src" ] || { echo "no source: $src"; exit 1; }

out="/tmp/extractor.${KIND}.js"
node -e 'import(new URL(process.argv[1],"file://'"$root"'/").href).then(m=>{require("fs").writeFileSync(process.argv[2], m.EXTRACT_JS); console.log("EXTRACT_JS bytes:", m.EXTRACT_JS.length);}).catch(e=>{console.error(e);process.exit(1)})' \
  "extension/src/extractors/${platform}/${type}.js" "$out"

aws s3 cp "$out" "s3://$BUCKET/extractors/${KIND}.js" \
  --profile "$PROFILE" --region "$REGION" --content-type application/javascript
echo "pushed extractors/${KIND}.js"
