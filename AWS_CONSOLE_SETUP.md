# LedgerFlow setup using only the AWS Console

No AWS CLI or terminal commands are needed in this guide. You will use the AWS
Console, GitHub, and Vercel websites.

Set the AWS Console region selector (top-right) to **Asia Pacific (Mumbai) —
ap-south-1** before creating resources.

## 1. Record your AWS account ID

In the AWS Console top-right menu, choose your account name and copy the
12-digit **Account ID**. You will use it in the S3 bucket name and IAM policy.

For the examples below, replace:

| Placeholder | Replace with |
| --- | --- |
| `ACCOUNT_ID` | Your 12-digit AWS account ID |
| `BUCKET_NAME` | `ledgerflow-private-documents-ACCOUNT_ID` |
| `VERCEL_URL` | Your final Vercel URL, such as `https://ledgerflow.vercel.app` |
| `APP_RUNNER_URL` | Your App Runner default domain, beginning with `https://` |

## 2. Create the private S3 bucket

1. Open **S3 → Buckets → Create bucket**.
2. Enter bucket name `ledgerflow-private-documents-ACCOUNT_ID`.
3. Select **Asia Pacific (Mumbai) ap-south-1**.
4. Leave **Block all public access** enabled and acknowledge the warning.
5. Under Bucket Versioning, select **Enable**.
6. Under Default encryption, select **SSE-S3**.
7. Select **Create bucket**.

Do not make this bucket public. It holds uploaded invoice documents.

## 3. Create the DynamoDB table and indexes

1. Open **DynamoDB → Tables → Create table**.
2. Set table name to `ledgerflow-documents`.
3. Set partition key to `PK` (String) and sort key to `SK` (String).
4. Open **Customize settings**.
5. Under Read/write capacity settings, select **On-demand**.
6. Create the table.
7. Open the table, then choose the **Indexes** tab → **Create index**.
8. Add these three global secondary indexes one at a time. For each index,
   choose projection type **All** and create it:

| Index name | Partition key (String) | Sort key (String) |
| --- | --- | --- |
| `GSI1` | `GSI1PK` | `GSI1SK` |
| `GSI2` | `GSI2PK` | `GSI2SK` |
| `GSI3` | `GSI3PK` | `GSI3SK` |

Wait until the table and all three indexes show **Active**.

## 4. Enable Amazon Bedrock Nova Lite

1. Open **Amazon Bedrock** in the Mumbai region.
2. Select **Model access** in the left menu.
3. Choose **Modify model access**.
4. Enable **Amazon Nova Lite** and submit.
5. Wait until access is granted.

If Nova Lite is unavailable in Mumbai, proceed without it. Later, set
`ENABLE_BEDROCK` to `false` in App Runner. Textract still extracts invoices.

## 5. Create the App Runner runtime IAM role

1. Open **IAM → Roles → Create role**.
2. Choose trusted entity type **AWS service**.
3. Select use case **App Runner**, then select the use case for an **instance
   role** (not an ECR access role).
4. Continue without attaching an AWS-managed policy.
5. Name the role `LedgerFlowAppRunnerInstanceRole` and create it.
6. Open that role → **Permissions** → **Add permissions** → **Create inline
   policy**.
7. Select the **JSON** editor. Replace all existing text with the policy below,
   replacing `ACCOUNT_ID` and `BUCKET_NAME` first.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvoiceFiles",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::BUCKET_NAME/orgs/*"
    },
    {
      "Sid": "DocumentRecords",
      "Effect": "Allow",
      "Action": ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:Query"],
      "Resource": [
        "arn:aws:dynamodb:ap-south-1:ACCOUNT_ID:table/ledgerflow-documents",
        "arn:aws:dynamodb:ap-south-1:ACCOUNT_ID:table/ledgerflow-documents/index/*"
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
      "Action": "bedrock:InvokeModel",
      "Resource": [
        "arn:aws:bedrock:ap-south-1::foundation-model/amazon.nova-lite-v1:0",
        "arn:aws:bedrock:*:ACCOUNT_ID:inference-profile/us.amazon.nova-lite-v1:0"
      ]
    }
  ]
}
```

8. Choose **Next**, name it `LedgerFlowRuntimeAccess`, then create the policy.

## 6. Deploy the backend with App Runner

First push this project to a GitHub repository using GitHub Desktop or the
GitHub website. Then:

1. Open **App Runner → Create service**.
2. Select **Source code repository**, connect GitHub, and select the repository
   and branch.
3. Select **Configure build** → Configuration file: **Configure all settings
   here**.
4. Set runtime to **Node.js 22**, source directory to `backend`, build command
   to `npm ci && npm run build`, start command to `npm run start`, and port to
   `8080`.
5. Under Service settings, set **Instance role** to
   `LedgerFlowAppRunnerInstanceRole`.
6. Add these environment variables. Use `https://ledgerflow.vercel.app` as a
   temporary value for `CORS_ORIGIN`; it is corrected after Vercel deploys.

| Name | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | `8080` |
| `LOG_LEVEL` | `info` |
| `CORS_ORIGIN` | `https://ledgerflow.vercel.app` (temporary) |
| `ORG_ID` | `demo` |
| `MAX_UPLOAD_MB` | `15` |
| `AWS_REGION` | `ap-south-1` |
| `S3_BUCKET` | Your `BUCKET_NAME` |
| `DYNAMODB_TABLE` | `ledgerflow-documents` |
| `ENABLE_TEXTRACT` | `true` |
| `ENABLE_BEDROCK` | `true` (or `false` if Nova Lite was unavailable) |
| `BEDROCK_MODEL_ID` | `us.amazon.nova-lite-v1:0` |

Do **not** add AWS access keys as environment variables; the instance role
supplies permissions.

7. Set Health check protocol to **HTTP** and path to `/health`.
8. Create service and wait for its status to become **Running**. Copy the
   **Default domain**; that is your `APP_RUNNER_URL`.

## 7. Deploy the frontend in Vercel (website only)

1. Open [Vercel](https://vercel.com/new) and sign in with GitHub.
2. Import the same GitHub repository.
3. In project settings before deployment, set **Root Directory** to `frontend`.
4. Under Environment Variables, add:

| Name | Value | Environment |
| --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | Your `APP_RUNNER_URL` | Production |

5. Deploy. Copy the final production URL from Vercel; this is `VERCEL_URL`.

## 8. Finish frontend/backend connectivity

1. Go to **App Runner → your service → Configuration → Edit**.
2. In Environment variables, replace the temporary `CORS_ORIGIN` value with
   the exact `VERCEL_URL`, for example `https://your-project.vercel.app`.
3. Save the changes and let App Runner redeploy.
4. Open the Vercel production URL and upload a test invoice.

The URLs must match exactly: include `https://`, do not include a trailing `/`,
and do not use `/health`. If the browser says **CORS error**, re-check that
`CORS_ORIGIN` exactly matches the Vercel domain, then redeploy App Runner.

## 9. Confirm it works

Open this in a browser, replacing the placeholder:

```text
APP_RUNNER_URL/health
```

The JSON should show repository `dynamodb`, storage `s3`, and `textract: true`.
Then use the Vercel site to upload a test invoice.
