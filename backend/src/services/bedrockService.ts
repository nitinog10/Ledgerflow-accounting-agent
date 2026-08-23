import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import { config } from '../config/env.js';
import {
  emptyInvoiceFields,
  lineItemSchema,
  taxSchema,
  type InvoiceFields,
} from '../types/document.js';
import { parseInvoiceDate } from '../utils/dates.js';
import { normalizeGstin } from '../utils/gstin.js';
import { logger } from '../utils/logger.js';
import { parseAmount } from '../utils/money.js';

/**
 * Bedrock has exactly one job here: tidy up labels that OCR read badly and
 * write a one-paragraph explanation for the accountant. It is never allowed to
 * introduce a value the document did not contain, and every number it returns
 * is re-validated by validationService afterwards.
 */

const SYSTEM_PROMPT = `You are an invoice validation assistant for an Indian accounting workflow.
Use ONLY the extracted fields supplied in the user message. Never invent a value.
Never calculate a missing total, tax or quantity - if it was not extracted, return null.
Normalize formatting only: trim vendor names, uppercase GSTIN, convert dates to YYYY-MM-DD,
convert amounts to plain numbers without currency symbols or thousand separators.
If a field is uncertain or absent, set it to null and list its name in missingFields.
List any field whose extracted value looks internally inconsistent in suspiciousFields.
Reply with a single JSON object and no other text, using exactly this shape:
{"fields":{"vendorName":string|null,"gstin":string|null,"invoiceNumber":string|null,"invoiceDate":string|null,"placeOfSupply":string|null,"lineItems":[{"name":string,"quantity":number|null,"rate":number|null,"amount":number|null,"hsn":string|null}],"subTotal":number|null,"tax":{"cgst":number|null,"sgst":number|null,"igst":number|null},"total":number|null},"missingFields":[string],"suspiciousFields":[string],"explanation":string}`;

const bedrockResponseSchema = z.object({
  fields: z.object({
    vendorName: z.string().nullable().optional(),
    gstin: z.string().nullable().optional(),
    invoiceNumber: z.string().nullable().optional(),
    invoiceDate: z.string().nullable().optional(),
    placeOfSupply: z.string().nullable().optional(),
    lineItems: z.array(lineItemSchema.partial({ quantity: true, rate: true, amount: true, hsn: true })).optional(),
    subTotal: z.union([z.number(), z.string()]).nullable().optional(),
    tax: taxSchema.partial().optional(),
    total: z.union([z.number(), z.string()]).nullable().optional(),
  }),
  missingFields: z.array(z.string()).default([]),
  suspiciousFields: z.array(z.string()).default([]),
  explanation: z.string().default(''),
});

export interface NormalizationResult {
  fields: InvoiceFields;
  missingFields: string[];
  suspiciousFields: string[];
  explanation: string;
}

/**
 * Vision extraction: used when Textract is not configured. Nova Lite reads the
 * invoice image directly. The same rules apply as everywhere else - the model
 * transcribes what is printed, deterministic code decides what it means.
 */
const VISION_SYSTEM_PROMPT = `You are an invoice extraction assistant for an Indian accounting workflow.
Read the supplied invoice document and transcribe ONLY what is printed on it. Never invent or calculate a value.
If a value is unreadable or absent, set it to null and list its name in missingFields.
Dates must be YYYY-MM-DD. Amounts must be plain numbers with no currency symbols or separators.
gstin is the SUPPLIER's 15-character GST number, uppercase (not the buyer's).
subTotal is the taxable value before tax. total is the grand total printed on the bill.
hasSignature is true only when a handwritten signature, initials or a stamp is visible; false when the signature area is clearly blank; null when unclear.
confidence is your overall reading confidence between 0 and 1; lower it for blurry or cut-off scans.
Reply with a single JSON object and no other text, using exactly this shape:
{"fields":{"vendorName":string|null,"gstin":string|null,"invoiceNumber":string|null,"invoiceDate":string|null,"placeOfSupply":string|null,"lineItems":[{"name":string,"quantity":number|null,"rate":number|null,"amount":number|null,"hsn":string|null}],"subTotal":number|null,"tax":{"cgst":number|null,"sgst":number|null,"igst":number|null},"total":number|null,"hasSignature":boolean|null},"confidence":number,"missingFields":[string],"explanation":string}`;

const visionResponseSchema = z.object({
  fields: z.object({
    vendorName: z.string().nullable().optional(),
    gstin: z.string().nullable().optional(),
    invoiceNumber: z.string().nullable().optional(),
    invoiceDate: z.string().nullable().optional(),
    placeOfSupply: z.string().nullable().optional(),
    lineItems: z
      .array(lineItemSchema.partial({ quantity: true, rate: true, amount: true, hsn: true }))
      .optional(),
    subTotal: z.union([z.number(), z.string()]).nullable().optional(),
    tax: taxSchema.partial().optional(),
    total: z.union([z.number(), z.string()]).nullable().optional(),
    hasSignature: z.boolean().nullable().optional(),
  }),
  confidence: z.number().optional(),
  missingFields: z.array(z.string()).default([]),
  explanation: z.string().default(''),
});

export interface VisionExtractionResult {
  fields: InvoiceFields;
  confidence: number;
  missingFields: string[];
  explanation: string;
}

/** Bedrock Converse image formats, by upload MIME type. */
const IMAGE_FORMATS: Record<string, 'jpeg' | 'png' | 'webp' | 'gif'> = {
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export class BedrockService {
  private readonly client = new BedrockRuntimeClient({ region: config.aws.bedrockRegion });

  /** One Converse round-trip that must come back as JSON. */
  private async converseJson(
    system: string,
    content: ContentBlock[],
    maxTokens: number,
  ): Promise<unknown> {
    const response = await this.client.send(
      new ConverseCommand({
        modelId: config.aws.bedrockModelId,
        system: [{ text: system }],
        messages: [{ role: 'user', content }],
        inferenceConfig: { temperature: 0, maxTokens, topP: 0.1 },
      }),
    );

    const text = (response.output?.message?.content ?? [])
      .map((block: ContentBlock) => ('text' in block ? block.text : ''))
      .join('')
      .trim();

    if (text.length === 0) throw new Error('Bedrock returned an empty response');
    return extractJson(text);
  }

  async normalize(input: {
    fields: InvoiceFields;
    fieldConfidence: Record<string, number>;
  }): Promise<NormalizationResult> {
    const payload = {
      extractedFields: input.fields,
      fieldConfidence: input.fieldConfidence,
    };

    const raw = await this.converseJson(SYSTEM_PROMPT, [{ text: JSON.stringify(payload) }], 1500);

    const parsed = bedrockResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Bedrock response failed schema validation: ${parsed.error.issues
          .map((issue) => issue.path.join('.'))
          .join(', ')}`,
      );
    }

    const merged = mergeNormalized(input.fields, parsed.data.fields);
    logger.debug('Bedrock normalization applied', {
      missingFields: parsed.data.missingFields.length,
      suspiciousFields: parsed.data.suspiciousFields.length,
    });

    return {
      fields: merged,
      missingFields: parsed.data.missingFields,
      suspiciousFields: parsed.data.suspiciousFields,
      explanation: parsed.data.explanation.trim(),
    };
  }

  /**
   * Reads an invoice image or PDF with the vision model. Used as the primary
   * extractor when Textract is not configured. Throws for file types Bedrock
   * cannot take (SVG samples never reach here - they use the demo path).
   */
  async extractFromDocument(input: {
    bytes: Buffer;
    mimeType: string;
  }): Promise<VisionExtractionResult> {
    const block = documentBlock(input.bytes, input.mimeType);
    const raw = await this.converseJson(
      VISION_SYSTEM_PROMPT,
      [block, { text: 'Extract the invoice fields as specified.' }],
      2000,
    );

    const parsed = visionResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `Bedrock vision response failed schema validation: ${parsed.error.issues
          .map((issue) => issue.path.join('.'))
          .join(', ')}`,
      );
    }

    const fields = coerceVisionFields(parsed.data.fields);
    // An out-of-range or missing self-assessment reads as "not sure", which the
    // validator turns into a low-confidence review flag rather than a guess.
    const confidence =
      typeof parsed.data.confidence === 'number' && Number.isFinite(parsed.data.confidence)
        ? Math.min(1, Math.max(0, parsed.data.confidence))
        : 0.6;

    logger.debug('Bedrock vision extraction complete', {
      confidence,
      lineItems: fields.lineItems.length,
    });

    return {
      fields,
      confidence,
      missingFields: parsed.data.missingFields,
      explanation: parsed.data.explanation.trim(),
    };
  }
}

/** Builds the Converse content block for the uploaded file. */
function documentBlock(bytes: Buffer, mimeType: string): ContentBlock {
  const imageFormat = IMAGE_FORMATS[mimeType.toLowerCase()];
  if (imageFormat) {
    return { image: { format: imageFormat, source: { bytes } } };
  }
  if (mimeType === 'application/pdf') {
    return { document: { format: 'pdf', name: 'invoice', source: { bytes } } };
  }
  throw new Error(`Bedrock vision cannot read "${mimeType}" files`);
}

/** Coerces the model's transcription into typed fields; parse failures -> null. */
function coerceVisionFields(
  suggested: z.infer<typeof visionResponseSchema>['fields'],
): InvoiceFields {
  const text = (value: string | null | undefined): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  return {
    ...emptyInvoiceFields(),
    vendorName: text(suggested.vendorName),
    gstin: normalizeGstin(text(suggested.gstin)),
    invoiceNumber: text(suggested.invoiceNumber),
    invoiceDate: suggested.invoiceDate ? parseInvoiceDate(suggested.invoiceDate) : null,
    placeOfSupply: text(suggested.placeOfSupply),
    lineItems: (suggested.lineItems ?? [])
      .filter((item) => text(item.name) !== null || item.amount != null)
      .map((item) => ({
        name: text(item.name) ?? 'Unlabelled item',
        quantity: parseAmount(item.quantity ?? null),
        rate: parseAmount(item.rate ?? null),
        amount: parseAmount(item.amount ?? null),
        hsn: text(item.hsn),
      })),
    subTotal: parseAmount(suggested.subTotal ?? null),
    tax: {
      cgst: parseAmount(suggested.tax?.cgst ?? null),
      sgst: parseAmount(suggested.tax?.sgst ?? null),
      igst: parseAmount(suggested.tax?.igst ?? null),
    },
    total: parseAmount(suggested.total ?? null),
    hasSignature: typeof suggested.hasSignature === 'boolean' ? suggested.hasSignature : null,
  };
}

/** Models sometimes wrap JSON in prose or a fenced block. */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1]?.trim() ?? text;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error('Bedrock response did not contain JSON');
  }
}

/**
 * The merge is intentionally conservative. Bedrock may clean up a string or
 * clear a value it considers unreliable, but a number it produces is only
 * accepted when OCR had nothing at all for that field.
 */
function mergeNormalized(
  original: InvoiceFields,
  suggested: z.infer<typeof bedrockResponseSchema>['fields'],
): InvoiceFields {
  const text = (value: string | null | undefined, fallback: string | null): string | null => {
    if (value === null) return null;
    if (typeof value !== 'string') return fallback;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  const numberOnlyIfMissing = (
    value: number | string | null | undefined,
    fallback: number | null,
  ): number | null => {
    if (fallback !== null) return fallback;
    const parsedValue = parseAmount(value ?? null);
    return parsedValue;
  };

  const gstin = normalizeGstin(text(suggested.gstin, original.gstin));
  const invoiceDate = suggested.invoiceDate
    ? parseInvoiceDate(suggested.invoiceDate) ?? original.invoiceDate
    : original.invoiceDate;

  const lineItems =
    original.lineItems.length > 0
      ? original.lineItems
      : (suggested.lineItems ?? []).map((item) => ({
          name: item.name,
          quantity: parseAmount(item.quantity ?? null),
          rate: parseAmount(item.rate ?? null),
          amount: parseAmount(item.amount ?? null),
          hsn: item.hsn ?? null,
        }));

  return {
    ...original,
    vendorName: text(suggested.vendorName, original.vendorName),
    gstin,
    invoiceNumber: text(suggested.invoiceNumber, original.invoiceNumber),
    invoiceDate,
    placeOfSupply: text(suggested.placeOfSupply, original.placeOfSupply),
    lineItems,
    subTotal: numberOnlyIfMissing(suggested.subTotal, original.subTotal),
    tax: {
      cgst: numberOnlyIfMissing(suggested.tax?.cgst, original.tax.cgst),
      sgst: numberOnlyIfMissing(suggested.tax?.sgst, original.tax.sgst),
      igst: numberOnlyIfMissing(suggested.tax?.igst, original.tax.igst),
    },
    total: numberOnlyIfMissing(suggested.total, original.total),
  };
}
