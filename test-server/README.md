# Test orchestrator (extractor auto-heal loop)

**Not part of the shipped extension.** A throwaway stand-in for n8n used only
during extractor development. It closes the loop so you never copy-paste HTML
by hand again:

```
extension --GET--> Lambda            returns one hardcoded scrape job
extension runs it (tab visible), captures the full page HTML
extension --POST--> Lambda           { status, data, html, steps }
Lambda --> S3                        runs/<ts>__<taskId>.{html,json} + latest.{html,json}
./test-server/pull.sh --> tools/captures/latest.html   (the AI reads it & fixes the extractor)
```

## One-time AWS grant (required)

This account guardrails Lambda creation: `PowerUserAccess` can create functions
but cannot `iam:PassRole`; the bootstrap role can't create functions. Grant the
`scraper-dev` (PowerUserAccess) SSO permission set one extra permission:

1. **IAM Identity Center** (region `eu-west-3`) → **Permission sets** →
   **PowerUserAccess** → **Inline policy** → add:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "PassLambdaExecRole",
         "Effect": "Allow",
         "Action": "iam:PassRole",
         "Resource": "arn:aws:iam::519041483453:role/ozeo-lambda-exec"
       }
     ]
   }
   ```

2. Save and let it re-provision to account `519041483453`.
3. Refresh creds: `aws sso login --sso-session MJSCONSEIL`.

## Deploy / update

```bash
./test-server/deploy.sh          # prints the Function URL + shared token
```

## Use

- Put the printed **Function URL** as both the poll (GET) and result (POST) URL
  in the extension, and the **shared token** as the token (already hardcoded as
  defaults — see extension/src/config.js).
- Enable the schedule (or hit Run) → after a run:

```bash
./test-server/pull.sh            # downloads latest.html + latest.json
```

## Files

- `handler.mjs` — Lambda handler (also mirrored inline in `template.yaml`).
- `deploy.sh` — create/update bucket + function + Function URL (single profile).
- `template.yaml` — CloudFormation variant (if you prefer a sanctioned CFN path).
- `pull.sh` — fetch the latest capture into `tools/captures/`.
