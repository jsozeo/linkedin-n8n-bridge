#!/usr/bin/env bash
# Deploy (or update) the test orchestrator Lambda + its S3 capture bucket.
# Idempotent: safe to re-run after editing handler.mjs.
#
#   ./test-server/deploy.sh
#
# Prints the Function URL at the end.
set -euo pipefail

REGION=eu-west-3
ACCOUNT=519041483453
PROFILE=cursor-admin                        # full admin (can PassRole + create fn)

FUNC=sm-bridge-test-orchestrator
ROLE=ozeo-lambda-exec                        # pre-existing Lambda execution role
ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/${ROLE}"
BUCKET=sm-bridge-test-captures-${ACCOUNT}
TOKEN=${SHARED_TOKEN:-smbridge_test_7Kd93PqL2xTn}

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

aws() { command aws --profile "$PROFILE" --region "$REGION" "$@"; }

echo "==> S3 bucket: $BUCKET"
if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  aws s3api create-bucket --bucket "$BUCKET" \
    --create-bucket-configuration LocationConstraint="$REGION"
fi

echo "==> Bucket policy (allow $ROLE to Get/PutObject)"
cat > /tmp/bucketpol.json <<JSON
{ "Version": "2012-10-17", "Statement": [
  { "Effect": "Allow", "Principal": { "AWS": "${ROLE_ARN}" },
    "Action": ["s3:PutObject","s3:GetObject"], "Resource": "arn:aws:s3:::${BUCKET}/*" } ] }
JSON
aws s3api put-bucket-policy --bucket "$BUCKET" --policy file:///tmp/bucketpol.json

echo "==> Package"
rm -f /tmp/${FUNC}.zip
zip -j /tmp/${FUNC}.zip handler.mjs >/dev/null

ENV="Variables={CAPTURE_BUCKET=${BUCKET},SHARED_TOKEN=${TOKEN}}"

echo "==> Lambda: $FUNC"
if aws lambda get-function --function-name "$FUNC" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FUNC" --zip-file fileb:///tmp/${FUNC}.zip >/dev/null
  aws lambda wait function-updated --function-name "$FUNC"
  aws lambda update-function-configuration --function-name "$FUNC" \
    --environment "$ENV" --timeout 60 --memory-size 256 >/dev/null
else
  aws lambda create-function --function-name "$FUNC" \
    --runtime nodejs20.x --handler handler.handler --role "$ROLE_ARN" \
    --zip-file fileb:///tmp/${FUNC}.zip --timeout 60 --memory-size 256 --environment "$ENV" >/dev/null
  aws lambda wait function-active-v2 --function-name "$FUNC"
fi

# NOTE: Lambda Function URLs return 403 Forbidden on this account despite a
# correct public resource policy + AuthType NONE (account-specific quirk, no SCP
# is responsible). We front the function with an API Gateway HTTP API instead —
# same payload format 2.0, so the handler is unchanged.
echo "==> API Gateway HTTP API"
FN_ARN="arn:aws:lambda:${REGION}:${ACCOUNT}:function:${FUNC}"
API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='sm-bridge-test'].ApiId | [0]" --output text)
if [ "$API_ID" = "None" ] || [ -z "$API_ID" ]; then
  API_ID=$(aws apigatewayv2 create-api --name sm-bridge-test --protocol-type HTTP \
    --target "$FN_ARN" --query ApiId --output text)
  aws lambda add-permission --function-name "$FUNC" --statement-id apigw-invoke \
    --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT}:${API_ID}/*" >/dev/null 2>&1 || true
fi
URL="https://${API_ID}.execute-api.${REGION}.amazonaws.com/"

echo
echo "================================================================"
echo "Endpoint     : $URL"
echo "Shared token : $TOKEN"
echo "Capture bkt  : s3://$BUCKET"
echo "================================================================"
