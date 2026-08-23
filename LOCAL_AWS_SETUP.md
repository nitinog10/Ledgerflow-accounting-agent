# Local setup with AWS DynamoDB + Bedrock

Goal: run **everything on localhost** — no deploy — with exactly two AWS
services behind it:

- **DynamoDB** stores the document records (instead of the local JSON file)
- **Bedrock Nova Lite** reads uploaded invoice photos with vision extraction

Files stay on your laptop. Textract and S3 are not used.

You will collect **3 values** and paste them into `backend/.env`:

| # | Value | Where it comes from |
| --- | --- | --- |
| 1 | `AWS_ACCESS_KEY_ID` | Step 2 |
| 2 | `AWS_SECRET_ACCESS_KEY` | Step 2 |
| 3 | `DYNAMODB_TABLE` (just uncomment) | Step 3 |

Everything below happens in the AWS **web console** — no CLI install needed.
Total time: ~15 minutes. Keep the region as **N. Virginia (us-east-1)** in the
console's top-right region picker for every step, because `backend/.env` says
`AWS_REGION=us-east-1`.

---

## Step 1 — Sign in

Go to https://console.aws.amazon.com and sign in. New accounts need a card,
but everything in this guide costs almost nothing (see the cost note at the
end).

Set the region (top-right, next to your account name) to **US East
(N. Virginia) us-east-1**.

## Step 2 — Create an IAM user and get the two keys

This creates a user that is allowed to do *only* DynamoDB on one table and
Bedrock on one model — nothing else.

1. In the console search bar type **IAM** → open it.
2. Left menu → **Users** → **Create user**.
3. User name: `ledgerflow-local` → **Next**.
4. Permissions: choose **Attach policies directly** → click **Create policy**
   (opens a new tab).
5. In the policy editor, pick the **JSON** tab and replace the contents with
   this (replace `YOUR_ACCOUNT_ID` with the 12-digit number shown under your
   account name, top-right):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "LedgerFlowDynamo",
         "Effect": "Allow",
         "Action": [
           "dynamodb:PutItem",
           "dynamodb:GetItem",
           "dynamodb:UpdateItem",
           "dynamodb:Query"
         ],
         "Resource": [
           "arn:aws:dynamodb:us-east-1:YOUR_ACCOUNT_ID:table/ledgerflow-documents",
           "arn:aws:dynamodb:us-east-1:YOUR_ACCOUNT_ID:table/ledgerflow-documents/index/*"
         ]
       },
       {
         "Sid": "LedgerFlowBedrock",
         "Effect": "Allow",
         "Action": "bedrock:InvokeModel",
         "Resource": [
           "arn:aws:bedrock:*::foundation-model/amazon.nova-lite-v1:0",
           "arn:aws:bedrock:*:YOUR_ACCOUNT_ID:inference-profile/us.amazon.nova-lite-v1:0"
         ]
       }
     ]
   }
   ```

6. **Next** → policy name `LedgerFlowLocalPolicy` → **Create policy**.
7. Back in the user tab, click the refresh icon next to the policy list,
   search `LedgerFlowLocalPolicy`, tick it → **Next** → **Create user**.
8. Open the user → **Security credentials** tab → **Access keys** →
   **Create access key**.
9. Choose **Local code** (or "Other") → **Next** → **Create access key**.
10. You now see the two values. **Copy both immediately** — the secret is
    shown only once:
    - `Access key` → paste into `backend/.env` as `AWS_ACCESS_KEY_ID=...`
    - `Secret access key` → paste as `AWS_SECRET_ACCESS_KEY=...`
    - Remove the `# ` at the start of both lines.

## Step 3 — Create the DynamoDB table

Fastest way is **CloudShell** — a terminal inside the AWS console, nothing to
install. Click the terminal icon (`>_`) in the console's top bar, wait for the
prompt, then paste this whole block:

```bash
aws dynamodb create-table \
  --region us-east-1 \
  --table-name ledgerflow-documents \
  --billing-mode PAY_PER_REQUEST \
  --attribute-definitions \
    AttributeName=PK,AttributeType=S \
    AttributeName=SK,AttributeType=S \
    AttributeName=GSI1PK,AttributeType=S \
    AttributeName=GSI1SK,AttributeType=S \
    AttributeName=GSI2PK,AttributeType=S \
    AttributeName=GSI2SK,AttributeType=S \
    AttributeName=GSI3PK,AttributeType=S \
    AttributeName=GSI3SK,AttributeType=S \
  --key-schema \
    AttributeName=PK,KeyType=HASH \
    AttributeName=SK,KeyType=RANGE \
  --global-secondary-indexes '[
    {"IndexName":"GSI1","KeySchema":[{"AttributeName":"GSI1PK","KeyType":"HASH"},{"AttributeName":"GSI1SK","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}},
    {"IndexName":"GSI2","KeySchema":[{"AttributeName":"GSI2PK","KeyType":"HASH"},{"AttributeName":"GSI2SK","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}},
    {"IndexName":"GSI3","KeySchema":[{"AttributeName":"GSI3PK","KeyType":"HASH"},{"AttributeName":"GSI3SK","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}
  ]'
```

Wait ~30 seconds, then confirm it's live:

```bash
aws dynamodb describe-table --table-name ledgerflow-documents \
  --region us-east-1 --query 'Table.TableStatus'
```

When it prints `"ACTIVE"`, go to `backend/.env` and remove the `# ` in front
of `DYNAMODB_TABLE=ledgerflow-documents`.

<details>
<summary>Prefer clicking instead of CloudShell?</summary>

DynamoDB console → **Create table** → name `ledgerflow-documents`, partition
key `PK` (String), sort key `SK` (String) → **Customize settings** → capacity
mode **On-demand** → under **Secondary indexes** click **Create global index**
three times:

| Index name | Partition key | Sort key |
| --- | --- | --- |
| `GSI1` | `GSI1PK` (String) | `GSI1SK` (String) |
| `GSI2` | `GSI2PK` (String) | `GSI2SK` (String) |
| `GSI3` | `GSI3PK` (String) | `GSI3SK` (String) |

Then **Create table**. The names must match exactly, including case.
</details>

## Step 4 — Turn on the Bedrock model

Model access is a one-time opt-in:

1. Console search → **Bedrock** → open it (still in us-east-1).
2. Left menu, bottom → **Model access**.
3. **Modify model access** → tick **Amazon → Nova Lite** → **Next** →
   **Submit**.
4. Amazon's own models are granted instantly — the row should say
   **Access granted** within a minute.

Nothing to paste for this step; `BEDROCK_MODEL_ID` is already set in `.env`.

## Step 5 — Restart and verify

```bash
cd backend
# Ctrl+C if it is running, then:
npm run dev
```

Open http://localhost:8080/health. You want exactly this:

```json
{
  "adapters": {
    "repository": "dynamodb",     <- records in AWS
    "storage": "local",           <- files on your laptop (by design)
    "textract": false,            <- off (by design)
    "bedrock": "us.amazon.nova-lite-v1:0"
  }
}
```

The dashboard header at http://localhost:3000 will also switch from
"SAMPLE EXTRACTION" to **"BEDROCK VISION"**.

Then the real test: **upload an actual invoice photo** (JPG/PNG) from the
dashboard. Watch the backend terminal — a `Bedrock vision extraction complete`
log line means Nova Lite read your image. The review page will show
**"Read by: Bedrock Nova vision"**.

Note: DynamoDB starts empty. Seed the sample bills into it once:

```bash
cd backend
npm run seed
```

## If something is wrong

| Symptom | Cause | Fix |
| --- | --- | --- |
| `/health` shows `repository: "memory"` | `DYNAMODB_TABLE` still has `#` in front, or backend not restarted | Uncomment, restart |
| `/health` shows `bedrock: false` | Keys not pasted / still commented | Step 2, restart |
| `ResourceNotFoundException` on every request | Table not created yet, or wrong region | Step 3; check `.env` region matches the console region |
| `AccessDeniedException ... bedrock` | Model access not granted, or policy account id wrong | Step 4; recheck `YOUR_ACCOUNT_ID` in the policy |
| `AccessDeniedException ... dynamodb` | Policy table name/region mismatch | Policy must say `us-east-1` and `ledgerflow-documents` |
| Upload shows "Sample extraction" instead of Bedrock | Bedrock call threw and the app fell back on purpose | Read the backend terminal for the real error |
| `UnrecognizedClientException` | Key pasted with a space / quote / missing character | Re-paste both keys, no quotes, no spaces |

## Cost for local testing

- **DynamoDB on-demand**: free tier covers 25 GB + millions of requests —
  effectively ₹0 for this.
- **Bedrock Nova Lite**: roughly ₹0.01–0.05 per invoice image. A hundred test
  uploads costs a few rupees.
- Nothing runs when your laptop is closed — there is no server to pause.

## Security notes

- `backend/.env` is gitignored; the keys stay on this machine. Never commit it.
- The IAM policy above cannot touch anything except this one table and one
  model — even if the keys leak, blast radius is small.
- Done testing? IAM → Users → `ledgerflow-local` → Security credentials →
  **Deactivate** the access key.
