#!/usr/bin/env bash
# Download the most recent capture (HTML + JSON) from the test orchestrator's
# S3 bucket into tools/captures/, so the extractor can be fixed from real DOM.
set -euo pipefail

REGION=eu-west-3
PROFILE=cursor-admin
BUCKET=sm-bridge-test-captures-519041483453

dest="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tools/captures"
mkdir -p "$dest"

aws s3 cp "s3://$BUCKET/latest.html" "$dest/latest.html" --profile "$PROFILE" --region "$REGION" 2>/dev/null \
  && echo "html -> tools/captures/latest.html" || echo "no latest.html yet"
aws s3 cp "s3://$BUCKET/latest.json" "$dest/latest.json" --profile "$PROFILE" --region "$REGION" 2>/dev/null \
  && echo "json -> tools/captures/latest.json" || echo "no latest.json yet"

# Also list the last few runs for reference.
echo "--- recent runs ---"
aws s3 ls "s3://$BUCKET/runs/" --profile "$PROFILE" --region "$REGION" 2>/dev/null | tail -10 || true
