# LedgerFlow Test Data

This folder contains synthetic invoice fixtures. They are safe to upload to the prototype because no real person, business, GSTIN, bank account, or customer document is used.

## Important: what is being tested

You are not training Amazon Bedrock for this prototype. Bedrock and Textract are already trained services.

You test whether the LedgerFlow pipeline does the right thing with a known document:

```text
invoice image -> OCR/AI output -> validation -> expected status and exceptions
```

The source image is in `invoices/`. The expected result is in `expected-results.json`. Compare the actual output with the expected output after every test run.

## Fixture scenarios

| File | Scenario | Expected status |
| --- | --- | --- |
| `01-clean-domestic.png` | Clean domestic invoice with CGST and SGST | `READY_FOR_APPROVAL` |
| `02-missing-gstin.png` | Supplier GSTIN is missing | `NEEDS_REVIEW` |
| `03-total-mismatch.png` | Displayed total does not match tax arithmetic | `NEEDS_REVIEW` |
| `04-duplicate-invoice.png` | Same invoice number as fixture 01 | `NEEDS_REVIEW` |
| `05-interstate-igst.png` | Clean interstate invoice with IGST | `READY_FOR_APPROVAL` |
| `06-low-quality-missing-quantity.png` | Low-quality image with a missing quantity | `NEEDS_REVIEW` |

## How to test during development

1. Upload one fixture image.
2. Check that the extracted vendor, invoice number, date, line items, tax, and total match `expected-results.json`.
3. Check that the expected exception appears.
4. Correct a `NEEDS_REVIEW` invoice and confirm it can be approved.
5. Confirm that an approved invoice exports to CSV and Tally XML.
6. Upload fixture 01, then fixture 04. Fixture 04 must be flagged as a duplicate.

## Two testing modes

### Mock mode

Before AWS services are connected, return the matching object from `mock-extractions.json` based on the uploaded file name. This tests the frontend, DynamoDB workflow, validations, review screen, and export without depending on live AI calls.

### Live mode

After Textract and Bedrock are connected, upload the real PNG files. Keep the expected JSON as the evaluation baseline. Low confidence or missing data is acceptable; invented values are not.

## What success looks like

- Both clean invoices reach `READY_FOR_APPROVAL`.
- All four intentionally bad invoices reach `NEEDS_REVIEW`.
- No missing field is silently guessed.
- The duplicate is detected.
- CSV and Tally XML are generated only after approval.

## Add more data after the demo

Create 20 to 50 more synthetic invoices with different fonts, phone-camera angles, vendors, tax layouts, and blurred scans. Only after customer permission and data-redaction controls exist should you create an anonymized real-world evaluation set.
