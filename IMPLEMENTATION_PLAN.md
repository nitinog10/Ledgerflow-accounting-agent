# LedgerFlow: Implementation Plan

## Goal for the two-hour prototype

Build one working path from invoice upload to approved accounting export:

```text
Upload image -> extract invoice data -> flag exception -> approve -> download CSV/Tally XML
```

Use hardcoded demo invoices and a fallback extraction response so that AWS account setup cannot prevent the demonstration.

## Chosen stack

| Layer | Choice | Reason |
| --- | --- | --- |
| Frontend | Next.js, TypeScript, Tailwind, Lucide | Fast dashboard development and Vercel deployment |
| Backend | Node.js, Express, TypeScript | Simple REST API and AWS SDK support |
| Hosting | Vercel frontend, AWS App Runner backend | Matches the requested deployment architecture |
| File storage | Private Amazon S3 bucket | Raw invoices do not belong in a database |
| OCR | Amazon Textract AnalyzeExpense | Purpose-built invoice and receipt extraction |
| AI validation | Amazon Bedrock Nova Lite | Normalize fields and create clear exception explanations |
| Database | Amazon DynamoDB on-demand | Serverless, low setup, and integrates cleanly with App Runner IAM |

## Architecture

```text
Browser
  -> Vercel / Next.js frontend
  -> AWS App Runner / Express API
       -> S3 private bucket for uploaded files
       -> Textract for OCR and invoice fields
       -> Bedrock Nova Lite for normalization and explanations
       -> DynamoDB for document status and extracted data
```

The browser communicates only with the App Runner API. It must never receive AWS credentials, Bedrock credentials, S3 credentials, or DynamoDB credentials.

## Repository structure

```text
impactlab/
  frontend/
    app/
    components/
    lib/
  backend/
    src/
      routes/
      services/
      repositories/
      utils/
    Dockerfile
    package.json
  docs/
```

For this prototype, keep the current two Markdown files in the repository root. Move them to `docs/` later if desired.

## DynamoDB design

Create one on-demand table named `ledgerflow-documents`.

| Attribute | Purpose |
| --- | --- |
| `PK` | `ORG#demo` for the prototype; one organization partition per firm in production |
| `SK` | `DOC#<uuid>` |
| `GSI1PK` | `ORG#demo#STATUS#<status>` |
| `GSI1SK` | `<createdAt>#DOC#<uuid>` |
| `GSI2PK` | `HASH#<sha256>` for duplicate detection |
| `GSI2SK` | `DOC#<uuid>` |

Store only normalized data in DynamoDB:

```json
{
  "documentId": "doc_123",
  "status": "NEEDS_REVIEW",
  "fileName": "supplier-invoice.jpg",
  "s3Key": "orgs/demo/documents/doc_123.jpg",
  "vendorName": "ABC Traders",
  "gstin": null,
  "invoiceNumber": "INV-189",
  "invoiceDate": "2026-08-23",
  "lineItems": [{ "name": "Steel Rod", "quantity": 10, "rate": 250 }],
  "tax": { "cgst": 225, "sgst": 225, "igst": 0 },
  "total": 2950,
  "confidence": 0.86,
  "exceptions": ["GSTIN_MISSING"],
  "createdAt": "2026-08-23T00:00:00.000Z"
}
```

Do not store full Textract responses in DynamoDB because records have a 400 KB item limit. Store the raw OCR result in S3 only when needed for debugging.

## Document processing flow

1. The frontend sends a file to `POST /api/documents/upload`.
2. The backend calculates a SHA-256 file hash and checks `GSI2` for duplicates.
3. The backend stores the original file in a private S3 bucket.
4. The backend creates a DynamoDB document record with status `PROCESSING`.
5. The backend calls Textract for invoice OCR.
6. The backend converts Textract output into a standard invoice JSON object.
7. The backend calls Bedrock only to normalize uncertain labels and generate an exception explanation.
8. Deterministic code validates GSTIN, totals, tax arithmetic, duplicate status, and required fields.
9. The backend saves the result with either `NEEDS_REVIEW` or `READY_FOR_APPROVAL`.
10. The frontend refreshes the document list every three seconds.

For the two-hour version, accept JPG and PNG invoices first. Treat multi-page PDF processing as a later enhancement because asynchronous document jobs add queue and callback setup.

## API endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/health` | App Runner health check |
| `POST` | `/api/documents/upload` | Upload and create a document record |
| `POST` | `/api/documents/:id/process` | Run the extraction workflow |
| `GET` | `/api/documents` | List document inbox and status queue |
| `GET` | `/api/documents/:id` | Get one document with extraction result |
| `PATCH` | `/api/documents/:id/review` | Correct fields and approve/reject |
| `POST` | `/api/documents/:id/export/csv` | Generate accounting CSV |
| `POST` | `/api/documents/:id/export/tally` | Generate downloadable Tally XML |
| `POST` | `/api/documents/:id/reminder` | Return a mock WhatsApp missing-field message |

## Bedrock prompt contract

Use `us.amazon.nova-lite-v1:0` with the Bedrock Converse API. Pass structured Textract output, not free-form user instructions.

```text
You are an invoice validation assistant.
Use only the supplied extracted fields.
Never invent a value.
Return JSON with normalized fields, missingFields, suspiciousFields, and a short explanation.
If a field is uncertain, set it to null and list it in missingFields.
```

Set a low temperature and validate the JSON response with Zod before saving it. If Bedrock fails, keep the Textract result and show a deterministic fallback exception message.

## Frontend screens

1. **Inbox dashboard**
   - Total documents, processing, needs review, approved, exported.
   - Table with status, vendor, invoice number, total, confidence, and action.

2. **Upload panel**
   - Drag-and-drop uploader.
   - `Use demo invoice` button so the presentation never depends on live OCR.

3. **Document review page**
   - Invoice preview on the left.
   - Editable extracted fields on the right.
   - Exception badges and confidence indicator.
   - Approve and reject actions.

4. **Export confirmation**
   - Download CSV.
   - Download Tally XML.
   - Show the audit event: `Approved by Demo Accountant`.

## Backend services

```text
documentService      upload, create status, retrieve document
storageService       upload and signed S3 preview URL
textractService      call AnalyzeExpense and map fields
bedrockService       normalize output and explain exceptions
validationService    GSTIN, totals, tax, required fields, duplicate checks
exportService        create CSV and Tally XML
documentRepository   DynamoDB queries and updates
```

## Environment variables

Frontend on Vercel:

```text
NEXT_PUBLIC_API_URL=https://your-service.awsapprunner.com
```

Backend on App Runner:

```text
AWS_REGION=us-east-1
S3_BUCKET=ledgerflow-private-documents
DYNAMODB_TABLE=ledgerflow-documents
BEDROCK_MODEL_ID=us.amazon.nova-lite-v1:0
CORS_ORIGIN=https://your-project.vercel.app
```

Keep sensitive values in AWS Secrets Manager. Do not put AWS access keys in environment variables. App Runner should use an IAM instance role.

## Required IAM permissions for the App Runner instance role

```text
s3:PutObject
s3:GetObject
dynamodb:PutItem
dynamodb:GetItem
dynamodb:UpdateItem
dynamodb:Query
textract:AnalyzeExpense
bedrock:InvokeModel
```

Scope these permissions to the specific S3 bucket, DynamoDB table, and allowed Bedrock model in production.

## Deployment steps

### Frontend: Vercel

1. Push the repository to GitHub.
2. Import `frontend/` into Vercel.
3. Add `NEXT_PUBLIC_API_URL`.
4. Deploy to production.

### Backend: AWS App Runner

1. Deploy `backend/` from GitHub or a Docker image.
2. Set build command to `npm ci`.
3. Set start command to `npm run start`.
4. Make the app listen on `process.env.PORT || 8080`.
5. Configure `/health` as an HTTP health check.
6. Add environment variables and attach the App Runner instance role.
7. Add the Vercel production URL to backend CORS.

## Two-hour execution schedule

| Time | Work | Required result |
| --- | --- | --- |
| 0-20 min | Create frontend dashboard with seeded invoice records | Polished visible product |
| 20-40 min | Build Express endpoints and DynamoDB repository | Inbox data persists |
| 40-60 min | Add review screen, validations, approval flow | One invoice can be processed manually |
| 60-75 min | Add CSV and Tally XML export | End-to-end business outcome |
| 75-90 min | Add Textract and Bedrock, with fallback data | AI extraction works if AWS setup succeeds |
| 90-110 min | Deploy App Runner and Vercel | Shareable URLs |
| 110-120 min | Test the demo path and polish status states | Reliable presentation |

## Demo sequence

1. Open the inbox and show the number of invoices waiting for review.
2. Upload or select a demo supplier invoice.
3. Show automatic extraction of vendor, invoice number, totals, and line items.
4. Highlight `GSTIN missing` or `total mismatch`.
5. Correct the field and approve it.
6. Download the generated Tally XML or CSV.
7. Close with: "The accountant reviewed one exception instead of typing the entire invoice."

## Do not spend time on today

- Real WhatsApp Business API onboarding.
- Gmail and Drive OAuth.
- Live Tally server integration.
- Zoho OAuth and posting.
- Multi-tenant authentication.
- Complex asynchronous PDF queues.

Use connector cards and clearly label them as upcoming integrations. The working upload-review-export workflow is the proof of value.
