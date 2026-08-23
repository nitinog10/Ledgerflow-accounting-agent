# LedgerFlow AWS manual setup (Windows)

Use this guide to set up AWS manually before deploying LedgerFlow. Keep this
terminal open while you work; the PowerShell variables set below last only for
the current terminal session.

## 1. Install and authenticate the AWS CLI

Install **AWS CLI v2** from [AWS](https://aws.amazon.com/cli/), then open a new
PowerShell window and confirm it is available:

```powershell
aws --version
```

Authenticate using the method provided by your AWS administrator. Do not share
access keys in chat, source control, or `.env` files.

For access keys:

```powershell
aws configure
```

Enter your access key ID, secret access key, default region `ap-south-1`, and
output format `json`.

For IAM Identity Center / SSO:

```powershell
aws configure sso
aws sso login
```

Verify the active account:

```powershell
aws sts get-caller-identity
```

## 2. Set PowerShell variables

```powershell
$env:AWS_REGION = 'ap-south-1'
$env:ACCOUNT_ID = aws sts get-caller-identity --query Account --output text
$env:SUFFIX = $env:ACCOUNT_ID
$env:BUCKET = "ledgerflow-private-documents-$env:SUFFIX"
$env:TABLE = 'ledgerflow-documents'
```

## 3. Create the private S3 bucket

```powershell
aws s3api create-bucket --bucket $env:BUCKET --region $env:AWS_REGION --create-bucket-configuration "LocationConstraint=$env:AWS_REGION"

aws s3api put-public-access-block --bucket $env:BUCKET --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

aws s3api put-bucket-encryption --bucket $env:BUCKET --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

aws s3api put-bucket-versioning --bucket $env:BUCKET --versioning-configuration Status=Enabled
```

## 4. Create the DynamoDB table

```powershell
aws dynamodb create-table --region $env:AWS_REGION --table-name $env:TABLE --billing-mode PAY_PER_REQUEST --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S AttributeName=GSI1PK,AttributeType=S AttributeName=GSI1SK,AttributeType=S AttributeName=GSI2PK,AttributeType=S AttributeName=GSI2SK,AttributeType=S AttributeName=GSI3PK,AttributeType=S AttributeName=GSI3SK,AttributeType=S --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE --global-secondary-indexes '[{"IndexName":"GSI1","KeySchema":[{"AttributeName":"GSI1PK","KeyType":"HASH"},{"AttributeName":"GSI1SK","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}},{"IndexName":"GSI2","KeySchema":[{"AttributeName":"GSI2PK","KeyType":"HASH"},{"AttributeName":"GSI2SK","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}},{"IndexName":"GSI3","KeySchema":[{"AttributeName":"GSI3PK","KeyType":"HASH"},{"AttributeName":"GSI3SK","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}]'

aws dynamodb wait table-exists --table-name $env:TABLE --region $env:AWS_REGION
```

## 5. Enable and test Bedrock Nova Lite

Check whether the model is offered in Mumbai:

```powershell
aws bedrock list-foundation-models --region $env:AWS_REGION --query "modelSummaries[?contains(modelId,'nova-lite')].modelId" --output table
```

In the AWS console, open **Amazon Bedrock → Model access → Modify model
access**, enable **Amazon Nova Lite**, and submit. Then test it:

```powershell
aws bedrock-runtime converse --region $env:AWS_REGION --model-id us.amazon.nova-lite-v1:0 --messages '[{"role":"user","content":[{"text":"Reply with the single word: ready"}]}]' --query 'output.message.content[0].text' --output text
```

If AWS reports an inference-profile validation error, retry with model ID
`amazon.nova-lite-v1:0`. If model access is not available in `ap-south-1`, set
`ENABLE_BEDROCK=false` in the backend deployment; Textract still works.

## 6. Create the App Runner instance role

Create two temporary JSON policy files in the repository root:

```powershell
@'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "tasks.apprunner.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
'@ | Set-Content -Encoding utf8 lf-trust.json

@"
{
  "Version": "2012-10-17",
  "Statement": [
    {"Sid":"InvoiceFiles","Effect":"Allow","Action":["s3:PutObject","s3:GetObject"],"Resource":"arn:aws:s3:::$env:BUCKET/orgs/*"},
    {"Sid":"DocumentRecords","Effect":"Allow","Action":["dynamodb:PutItem","dynamodb:GetItem","dynamodb:UpdateItem","dynamodb:Query"],"Resource":["arn:aws:dynamodb:$env:AWS_REGION`:$env:ACCOUNT_ID`:table/$env:TABLE","arn:aws:dynamodb:$env:AWS_REGION`:$env:ACCOUNT_ID`:table/$env:TABLE/index/*"]},
    {"Sid":"InvoiceOcr","Effect":"Allow","Action":"textract:AnalyzeExpense","Resource":"*"},
    {"Sid":"NormalizationModelOnly","Effect":"Allow","Action":["bedrock:InvokeModel"],"Resource":["arn:aws:bedrock:$env:AWS_REGION::foundation-model/amazon.nova-lite-v1:0","arn:aws:bedrock:*:$env:ACCOUNT_ID`:inference-profile/us.amazon.nova-lite-v1:0"]}
  ]
}
"@ | Set-Content -Encoding utf8 lf-policy.json

aws iam create-role --role-name LedgerFlowAppRunnerInstanceRole --assume-role-policy-document file://lf-trust.json
aws iam put-role-policy --role-name LedgerFlowAppRunnerInstanceRole --policy-name LedgerFlowRuntimeAccess --policy-document file://lf-policy.json
```

Keep the role name **LedgerFlowAppRunnerInstanceRole** for the deployment.

## 7. Deploy the backend in App Runner

1. Push this repository to GitHub.
2. In AWS Console, open **App Runner → Create service**.
3. Choose **Source code repository**, connect GitHub, and select this repo and
   branch.
4. Set source directory to `backend`, runtime to **Node.js 22**, build command
   to `npm ci && npm run build`, start command to `npm run start`, and port to
   `8080`.
5. In Service settings, set the instance role to
   `LedgerFlowAppRunnerInstanceRole`.
6. Copy environment variables from `backend/.env.production.example`. Set
   `S3_BUCKET` to the bucket created above and initially use a placeholder for
   `CORS_ORIGIN` (it is updated after Vercel is deployed).
7. Set health check to HTTP path `/health`, then create the service.

When it finishes, record the App Runner URL.

## 8. Connect the frontend and backend

The frontend calls the backend from the browser. This requires two matching
settings:

| Where | Variable | Value |
| --- | --- | --- |
| Vercel frontend | `NEXT_PUBLIC_API_URL` | The complete App Runner URL, for example `https://abc123.ap-south-1.awsapprunner.com` |
| App Runner backend | `CORS_ORIGIN` | The complete Vercel production URL, for example `https://ledgerflow.vercel.app` |

Use URLs only: no trailing slash, path, quote characters, or `/health` suffix.
`NEXT_PUBLIC_API_URL` is deliberately public because it is embedded in the
browser bundle; do not put AWS keys or other secrets in any `NEXT_PUBLIC_*`
variable.

App Runner is deployed before Vercel, but the backend needs the final Vercel
origin for CORS. Complete the connection in this order:

1. During the first App Runner deployment, set `CORS_ORIGIN` to a temporary
   placeholder such as `https://ledgerflow.vercel.app`.
2. After App Runner is ready, copy its **Default domain** from the service
   overview. It must use `https://`.
3. Add that domain as `NEXT_PUBLIC_API_URL` in Vercel and deploy the frontend.
4. Copy the resulting Vercel **production** domain.
5. Edit the App Runner service configuration, replace `CORS_ORIGIN` with the
   Vercel production domain, and redeploy the backend.

The backend supports several allowed frontend origins by using a comma-separated
`CORS_ORIGIN` value. For example, to permit both production and one stable
preview domain:

```text
https://ledgerflow.vercel.app,https://ledgerflow-git-main-your-team.vercel.app
```

Do not use `*` in production.

## 9. Deploy the frontend to Vercel

From the repository root:

```powershell
cd frontend
npx vercel link
npx vercel env add NEXT_PUBLIC_API_URL production
# Paste the App Runner URL when prompted.
npx vercel --prod
```

Copy the Vercel production URL. In App Runner, edit the service configuration,
set `CORS_ORIGIN` to that exact URL (including `https://`, with no trailing
slash), and redeploy. This final backend redeploy is necessary because CORS is
checked by the browser before the API response can be read.

## 10. Verify connectivity

```powershell
curl https://YOUR-APP-RUNNER-URL/health
```

The response should report `dynamodb` for the repository, `s3` for storage,
and `textract: true`. `memory` or `local` means the matching environment
variable was omitted. Then open the Vercel URL, upload a test invoice, and
check the browser developer console's **Network** tab. API requests should go
to the App Runner domain and return successful responses. A browser CORS error
means `CORS_ORIGIN` is not an exact match for the deployed Vercel origin; edit
it and redeploy App Runner.

## Cleanup (optional)

These commands permanently delete the deployed resources and all S3 documents:

```powershell
aws dynamodb delete-table --table-name $env:TABLE --region $env:AWS_REGION
aws s3 rm "s3://$env:BUCKET" --recursive
aws s3api delete-bucket --bucket $env:BUCKET --region $env:AWS_REGION
aws iam delete-role-policy --role-name LedgerFlowAppRunnerInstanceRole --policy-name LedgerFlowRuntimeAccess
aws iam delete-role --role-name LedgerFlowAppRunnerInstanceRole
```
