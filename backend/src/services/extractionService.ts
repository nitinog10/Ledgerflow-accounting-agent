import { config } from '../config/env.js';
import { demoInvoiceForHash, findDemoInvoice } from '../demo/demoInvoices.js';
import type { InvoiceDocument, InvoiceFields } from '../types/document.js';
import { logger } from '../utils/logger.js';
import { BedrockService } from './bedrockService.js';
import { TextractService } from './textractService.js';

export interface ExtractionOutcome {
  engine: InvoiceDocument['extractionEngine'];
  fields: InvoiceFields;
  confidence: number;
  /** Bedrock's sentence for the accountant, when it produced one. */
  explanation: string | null;
  /** Non-fatal problems worth showing in the activity log. */
  notes: string[];
  failed: boolean;
}

/**
 * Chooses the best extraction path available and degrades instead of failing:
 *
 *   Textract + Bedrock  ->  full pipeline when AWS is reachable
 *   Textract only       ->  OCR succeeded, normalization did not
 *   Demo fallback       ->  no AWS at all, or OCR threw
 *
 * The last row is why the demo cannot break. A presentation must not depend on
 * an IAM role being attached in time.
 */
export class ExtractionService {
  private readonly textract = config.features.textract ? new TextractService() : null;
  private readonly bedrock = config.features.bedrock ? new BedrockService() : null;

  async extract(input: {
    bytes: Buffer;
    fileHash: string;
    demoSlug?: string | null;
  }): Promise<ExtractionOutcome> {
    if (input.demoSlug) {
      const demo = findDemoInvoice(input.demoSlug);
      if (demo) {
        return {
          engine: 'DEMO_FALLBACK',
          fields: structuredClone(demo.fields),
          confidence: demo.confidence,
          explanation: demo.teaches,
          notes: ['Seeded demo invoice: extraction values are fixed.'],
          failed: false,
        };
      }
    }

    if (!this.textract) {
      const demo = demoInvoiceForHash(input.fileHash);
      return {
        engine: 'DEMO_FALLBACK',
        fields: structuredClone(demo.fields),
        confidence: demo.confidence,
        explanation: null,
        notes: [
          'Textract is not configured, so a representative sample extraction was used for this file.',
        ],
        failed: false,
      };
    }

    const notes: string[] = [];
    let ocr;
    try {
      ocr = await this.textract.analyzeExpense(input.bytes);
    } catch (error) {
      logger.warn('Textract failed, using fallback extraction', {
        error: (error as Error).message,
      });
      const demo = demoInvoiceForHash(input.fileHash);
      return {
        engine: 'DEMO_FALLBACK',
        fields: structuredClone(demo.fields),
        confidence: demo.confidence,
        explanation: null,
        notes: [`Textract call failed (${(error as Error).message}); fallback extraction used.`],
        failed: false,
      };
    }

    if (!this.bedrock) {
      return {
        engine: 'TEXTRACT',
        fields: ocr.fields,
        confidence: ocr.confidence,
        explanation: null,
        notes: ['Bedrock normalization is disabled; raw OCR fields were kept.'],
        failed: false,
      };
    }

    try {
      const normalized = await this.bedrock.normalize({
        fields: ocr.fields,
        fieldConfidence: ocr.fieldConfidence,
      });
      if (normalized.suspiciousFields.length > 0) {
        notes.push(`Model flagged as suspicious: ${normalized.suspiciousFields.join(', ')}.`);
      }
      return {
        engine: 'TEXTRACT_BEDROCK',
        fields: normalized.fields,
        confidence: ocr.confidence,
        explanation: normalized.explanation.length > 0 ? normalized.explanation : null,
        notes,
        failed: false,
      };
    } catch (error) {
      logger.warn('Bedrock normalization failed, keeping OCR output', {
        error: (error as Error).message,
      });
      return {
        engine: 'TEXTRACT',
        fields: ocr.fields,
        confidence: ocr.confidence,
        explanation: null,
        notes: [`Bedrock normalization failed (${(error as Error).message}); OCR fields kept.`],
        failed: false,
      };
    }
  }
}
