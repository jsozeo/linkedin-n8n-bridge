#!/usr/bin/env bash
# Agent-side driver: enqueue ONE job, block until its capture comes back, pull
# it locally, and print a short summary. This is what closes the loop without
# opening a tab every minute — one deliberate run per invocation.
#
#   ./test-server/run.sh <kind> <url>
set -euo pipefail

KIND=${1:?usage: run.sh <kind> <url>}
URL=${2:?usage: run.sh <kind> <url>}
REGION=eu-west-3
PROFILE=cursor-admin
BUCKET=sm-bridge-test-captures-519041483453
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

taskId() { aws s3 cp "s3://$BUCKET/latest.json" - --profile "$PROFILE" --region "$REGION" 2>/dev/null \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('taskId',''))" 2>/dev/null || true; }

prev=$(taskId)
"$root/test-server/set-job.sh" "$KIND" "$URL"
echo "waiting for the extension to pick it up + run (up to ~5 min)…"
got=""
for i in $(seq 1 30); do
  sleep 12
  cur=$(taskId)
  if [ -n "$cur" ] && [ "$cur" != "$prev" ]; then got="$cur"; break; fi
  printf '.'
done
echo
[ -n "$got" ] || { echo "TIMEOUT: no capture yet. The extension may be closed or not polling."; exit 2; }

"$root/test-server/pull.sh" >/dev/null 2>&1 || true
python3 - "$root/tools/captures/latest.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
data=d.get('data') or {}
res=data.get('result') if isinstance(data,dict) else None
print("status :", d.get('status'), "| task:", d.get('taskId'), "| durationMs:", data.get('durationMs') if isinstance(data,dict) else None)
if isinstance(res,dict):
    print("count  :", res.get('count'))
    print("keys   :", list(res.keys()))
    p=res.get('_probe')
    if p: print("_probe :", json.dumps(p))
steps=(data.get('steps') if isinstance(data,dict) else None) or d.get('steps') or []
prog=[s.get('merged') for s in steps if s.get('label')=='scroll_extract']
if prog: print("scroll :", prog)
fails=[s for s in steps if 'failed' in s.get('label','')]
for f in fails[:6]: print("  fail:", f.get('label'), f.get('message') or f.get('sel'))
print("html   : tools/captures/latest.html")
PY
