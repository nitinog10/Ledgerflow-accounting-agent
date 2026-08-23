import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
} from '@aws-sdk/client-bedrock-runtime';
import { z } from 'zod';
import { config } from '../config/env.js';
import { lineItemSchema, taxSchema, type InvoiceFields } from '../types/document.js';
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

export class BedrockService {
  private readonly client = new BedrockRuntimeClient({ region: config.aws.region });

  async normalize(input: {
    fields: InvoiceFields;
    fieldConfidence: Record<string, number>;
  }): Promise<NormalizationResult> {
    const payload = {
      extractedFields: input.fields,
      fieldConfidence: input.fieldConfidence,
    };

    const response = await this.client.send(
      new ConverseCommand({
        modelId: config.aws.bedrockModelId,
        system: [{ text: SYSTEM_PROMPT }],
        messages: [
          {
            role: 'user',
            content: [{ text: JSON.stringify(payload) }],
          },
        ],
        inferenceConfig: { temperature: 0, maxTokens: 1500, topP: 0.1 },
      }),
    );

    const text = (response.output?.message?.content ?? [])
      .map((block: ContentBlock) => ('text' in block ? block.text : ''))
      .join('')
      .trim();

    if (text.length === 0) throw new Error('Bedrock returned an empty response');

    const parsed = bedrockResponseSchema.safeParse(extractJson(text));
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
