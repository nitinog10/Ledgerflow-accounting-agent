# AWS setup

Copy-paste, in order. Roughly 20 minutes, most of it waiting for App Runner.

You do not need any of this to run the demo — LedgerFlow works fully on a laptop
with no AWS account. Do this when you want real OCR and a shareable URL.

## 0. Before you start

```bash
aws --version              # need v2
aws sts get-caller-identity   # confirms you are logged in
```

Pick your region once and use it everywhere. `ap-south-1` (Mumbai) keeps
Indian invoice data in India and is closest to Bhopal.

```bash
export AWS_REGION=ap-south-1
export ACCOUNT_ID=779846808350
export SUFFIX=$ACCOUNT_ID              # bucket names are globally unique
export BUCKET=ledgerflow-private-documents-$SUFFIX
export TABLE=ledgerflow-documents
```

> On Windows PowerShell use `$env:AWS_REGION="ap-south-1"` and `$env:BUCKET=...`
> instead of `export`.

**Region caveat for Bedrock.** Nova Lite is not in every region. If
`ap-south-1` does not offer it (check step 4), keep S3, DynamoDB and Textract in
`ap-south-1` and set only `BEDROCK_MODEL_ID` against a region that does — or
simply run with `ENABLE_BEDROCK=false`. Textract's deterministic output plus
LedgerFlow's own validation is enough; Bedrock only tidies labels.

## 1. Private S3 bucket

```bash
aws s3api create-bucket \
  --bucket $BUCKET \
  --region $AWS_REGION \
  --create-bucket-configuration LocationConstraint=$AWS_REGION

# No public access, ever. Invoices are customer documents.
aws s3api put-public-access-block \
  --bucket $BUCKET \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

aws s3api put-bucket-encryption \
  --bucket $BUCKET \
  --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

aws s3api put-bucket-versioning \
  --bucket $BUCKET --versioning-configuration Status=Enabled
```

## 2. DynamoDB table

One on-demand table with three global secondary indexes: status queue,
file-hash duplicates, and vendor+invoice-number duplicates.

```bash
aws dynamodb create-table \
  --region $AWS_REGION \
  --table-name $TABLE \
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
    {"IndexName":"GSI1",
     "KeySchema":[{"AttributeName":"GSI1PK","KeyType":"HASH"},{"AttributeName":"GSI1SK","KeyType":"RANGE"}],
     "Projection":{"ProjectionType":"ALL"}},
    {"IndexName":"GSI2",
     "KeySchema":[{"AttributeName":"GSI2PK","KeyType":"HASH"},{"AttributeName":"GSI2SK","KeyType":"RANGE"}],
     "Projection":{"ProjectionType":"ALL"}},
    {"IndexName":"GSI3",
     "KeySchema":[{"AttributeName":"GSI3PK","KeyType":"HASH"},{"AttributeName":"GSI3SK","KeyType":"RANGE"}],
     "Projection":{"ProjectionType":"ALL"}}
  ]'

aws dynamodb wait table-exists --table-name $TABLE --region $AWS_REGION
```

## 3. Textract

Nothing to provision. `AnalyzeExpense` is called synchronously with the file
bytes, so no S3 round-trip and no async job queue. It is on by default in every
region that supports it.

## 4. Bedrock model access

Model access is opt-in per account and per region, and it is the step people
forget.

```bash
# Is Nova Lite available in this region?
aws bedrock list-foundation-models --region $AWS_REGION \
  --query "modelSummaries[?contains(modelId,'nova-lite')].modelId" --output table
```

Then open **Bedrock console → Model access → Modify model access**, tick
**Amazon Nova Lite**, and submit. Amazon's own models are usually granted
instantly. Verify:

```bash
aws bedrock-runtime converse \
  --region $AWS_REGION \
  --model-id us.amazon.nova-lite-v1:0 \
  --messages '[{"role":"user","content":[{"text":"Reply with the single word: ready"}]}]' \
  --query 'output.message.content[0].text' --output text
```

If that errors with `AccessDeniedException`, access is not granted yet. If it
errors with `ValidationException` about the inference profile, drop the `us.`
prefix and use `amazon.nova-lite-v1:0`, then set `BEDROCK_MODEL_ID` to match.

## 5. IAM role for App Runner

Two roles are involved and they are easy to confuse:

- **Instance role** — what your running code uses. This is the one below.
- **Access role** — only needed if you deploy from a private ECR image.

```bash
cat > /tmp/lf-trust.json <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "tasks.apprunner.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
JSON

aws iam create-role \
  --role-name LedgerFlowAppRunnerInstanceRole \
  --assume-role-policy-document file:///tmp/lf-trust.json
```

Now the permission policy — scoped to exactly these resources, not `*`:

```bash
cat > /tmp/lf-policy.json <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvoiceFiles",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::$BUCKET/orgs/*"
    },
    {
      "Sid": "DocumentRecords",
      "Effect": "Allow",
      "Action": [
        "dynamodb:PutItem", "dynamodb:GetItem",
        "dynamodb:UpdateItem", "dynamodb:Query"
      ],
      "Resource": [
        "arn:aws:dynamodb:$AWS_REGION:$ACCOUNT_ID:table/$TABLE",
        "arn:aws:dynamodb:$AWS_REGION:$ACCOUNT_ID:table/$TABLE/index/*"
      ]
    },
    {
      "Sid": "InvoiceOcr",
      "Effect": "Allow",
      "Action": "textract:AnalyzeExpense",
      "Resource": "*"
    },
    {
      "Sid": "NormalizationModelOnly",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel"],
      "Resource": [
        "arn:aws:bedrock:$AWS_REGION::foundation-model/amazon.nova-lite-v1:0",
        "arn:aws:bedrock:*:$ACCOUNT_ID:inference-profile/us.amazon.nova-lite-v1:0"
      ]
    }
  ]
}
JSON

aws iam put-role-policy \
  --role-name LedgerFlowAppRunnerInstanceRole \
  --policy-name LedgerFlowRuntimeAccess \
  --policy-document file:///tmp/lf-policy.json
```

`textract:AnalyzeExpense` takes `"*"` because Textract has no resource ARN for
synchronous calls. Everything else is pinned.

## 6. Deploy the backend to App Runner

Easiest path is source-based deploy from GitHub, which needs no Docker build.

1. Push this repo to GitHub.
2. **App Runner console → Create service → Source code repository.**
3. Connect GitHub, pick the repo and branch.
4. **Source directory:** `backend`
5. Runtime **Node.js 22**, and:
   - Build command: `npm ci && npm run build`
   - Start command: `npm run start`
   - Port: `8080`
6. **Service settings → Instance role:** `LedgerFlowAppRunnerInstanceRole`
7. **Environment variables:** paste from `backend/.env.production.example`,
   filling in your real bucket name and Vercel URL.
8. **Health check:** HTTP, path `/health`.
9. Create. First deploy takes about 5–10 minutes.

Then confirm every adapter came up on AWS rather than falling back:

```bash
curl -s https://<your-service>.ap-south-1.awsapprunner.com/health | jq
```

You want to see this — `memory` or `local` means an env var did not take:

```json
{
  "status": "ok",
  "adapters": {
    "repository": "dynamodb",
    "storage": "s3",
    "textract": true,
    "bedrock": "us.amazon.nova-lite-v1:0"
  }
}
```

If you would rather ship a container, `backend/Dockerfile` is ready:

```bash
aws ecr create-repository --repository-name ledgerflow-backend --region $AWS_REGION
aws ecr get-login-password --region $AWS_REGION \
  | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com
docker build -t ledgerflow-backend ./backend
docker tag ledgerflow-backend $ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/ledgerflow-backend:latest
docker push $ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/ledgerflow-backend:latest
```

## 7. Deploy the frontend to Vercel

```bash
cd frontend
npx vercel link
npx vercel env add NEXT_PUBLIC_API_URL production
# paste: https://<your-service>.ap-south-1.awsapprunner.com
npx vercel --prod
```

## 8. Close the loop on CORS

The two services have to know each other's URL, so this is circular by nature:
deploy the backend first with a placeholder, then come back.

Once Vercel gives you the production domain, update `CORS_ORIGIN` on the App
Runner service to that exact origin (scheme, no trailing slash) and redeploy.
Until that matches, the dashboard loads but every request fails in the browser
console with a CORS error.

## Cost

At demo volume this is small change — a few rupees a day:

| Service | Free tier | After that |
| --- | --- | --- |
| Textract AnalyzeExpense | 100 pages/month for 3 months | ~$0.01 per page |
| Bedrock Nova Lite | none | ~$0.00006 per 1K input tokens |
| DynamoDB on-demand | 25 GB storage | ~$1.25 per million writes |
| S3 | 5 GB for 12 months | ~$0.023 per GB/month |
| App Runner | none | ~$5–7/month for the smallest always-on instance |

App Runner is the only meaningful line. Pause the service between demos:

```bash
aws apprunner pause-service --service-arn <arn> --region $AWS_REGION
aws apprunner resume-service --service-arn <arn> --region $AWS_REGION
```

## Tearing it all down

```bash
aws apprunner delete-service --service-arn <arn> --region $AWS_REGION
aws dynamodb delete-table --table-name $TABLE --region $AWS_REGION
aws s3 rm s3://$BUCKET --recursive && aws s3api delete-bucket --bucket $BUCKET --region $AWS_REGION
aws iam delete-role-policy --role-name LedgerFlowAppRunnerInstanceRole --policy-name LedgerFlowRuntimeAccess
aws iam delete-role --role-name LedgerFlowAppRunnerInstanceRole
```

## When something is wrong

| What you see | Cause | Fix |
| --- | --- | --- |
| `/health` says `repository: memory` | `DYNAMODB_TABLE` not set on the service | Add the env var, redeploy |
| `/health` says `storage: local` | `S3_BUCKET` not set | Same |
| `/health` says `textract: false` | `ENABLE_TEXTRACT=auto` and no credentials found | Attach the instance role, or set `ENABLE_TEXTRACT=true` |
| Uploads succeed but every bill shows "Sample extraction" | Textract threw and the app fell back on purpose | Check App Runner logs for the Textract error |
| `AccessDeniedException` on Bedrock | Model access not granted in this region | Step 4 |
| Browser console CORS error | `CORS_ORIGIN` does not match the Vercel origin exactly | Step 8 |
| `ResourceNotFoundException` naming GSI3 | Table created without the third index | Add `GSI3` to the table, or `aws dynamodb delete-table` and rerun step 2 |
