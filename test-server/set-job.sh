#!/usr/bin/env bash
# Enqueue ONE job for the extension to pick up on its next poll (one-shot).
# The handler consumes it (status pending -> served) so the tab opens once.
#
#   ./test-server/set-job.sh <kind> <url>
#   ./test-server/set-job.sh idle            # park: extension opens no tabs
#
# Examples:
#   ./test-server/set-job.sh linkedin.company "https://www.linkedin.com/company/airbus/"
#   ./test-server/set-job.sh linkedin.profile "https://www.linkedin.com/in/xxx/"
set -euo pipefail

REGION=eu-west-3
PROFILE=cursor-admin
BUCKET=sm-bridge-test-captures-519041483453
KEY="s3://$BUCKET/job.json"

KIND=${1:-idle}
URL=${2:-}

if [ "$KIND" = "idle" ]; then
  printf '{\n  "status": "idle"\n}\n' > /tmp/job.json
  aws s3 cp /tmp/job.json "$KEY" --profile "$PROFILE" --region "$REGION" --content-type application/json >/dev/null
  echo "job parked (idle) — no tabs will open"
  exit 0
fi

[ -n "$URL" ] || { echo "usage: set-job.sh <kind> <url>"; exit 1; }
cat > /tmp/job.json <<JSON
{
  "kind": "$KIND",
  "url": "$URL",
  "active": true,
  "captureHtml": true,
  "status": "pending"
}
JSON
aws s3 cp /tmp/job.json "$KEY" --profile "$PROFILE" --region "$REGION" --content-type application/json >/dev/null
echo "enqueued: $KIND -> $URL  (will run once on next poll)"
