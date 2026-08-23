'use client';

import { AmountField, DateField, FieldGroupRow, FieldRow, TextField } from './FieldRow';
import type { InvoiceFields, InvoiceException } from '@/lib/types';

/**
 * The extraction sheet. Every value is editable because the accountant is the
 * authority on what the paper says; the system only proposes.
 */
export function FieldsEditor({
  fields,
  exceptions,
  onChange,
}: {
  fields: InvoiceFields;
  exceptions: InvoiceException[];
  onChange: (next: InvoiceFields) => void;
}) {
  const flagged = new Set(
    exceptions.map((exception) => exception.field).filter((field): field is string => field !== null),
  );

  const set = <K extends keyof InvoiceFields>(key: K, value: InvoiceFields[K]) =>
    onChange({ ...fields, [key]: value });

  const setTax = (key: keyof InvoiceFields['tax'], value: number | null) =>
    onChange({ ...fields, tax: { ...fields.tax, [key]: value } });

  return (
    <div className="border border-rule bg-paper">
      <div className="rule-b bg-paper-raised px-[14px] py-2.5">
        <h3 className="eyebrow">Extracted fields</h3>
      </div>

      <FieldRow id="field-vendor" label="Vendor" flagged={flagged.has('vendorName')}>
        <TextField
          id="field-vendor"
          value={fields.vendorName}
          onChange={(next) => set('vendorName', next)}
        />
      </FieldRow>

      <FieldRow id="field-gstin" label="GSTIN" hint="15 characters" flagged={flagged.has('gstin')}>
        <TextField
          id="field-gstin"
          value={fields.gstin}
          onChange={(next) => set('gstin', next)}
          mono
          uppercase
          maxLength={15}
          placeholder="not printed on the bill"
        />
      </FieldRow>

      <FieldRow
        id="field-invoice-number"
        label="Invoice no."
        flagged={flagged.has('invoiceNumber')}
      >
        <TextField
          id="field-invoice-number"
          value={fields.invoiceNumber}
          onChange={(next) => set('invoiceNumber', next)}
          mono
        />
      </FieldRow>

      <FieldRow id="field-invoice-date" label="Invoice date" flagged={flagged.has('invoiceDate')}>
        <DateField
          id="field-invoice-date"
          value={fields.invoiceDate}
          onChange={(next) => set('invoiceDate', next)}
        />
      </FieldRow>

      <FieldRow
        id="field-place-of-supply"
        label="Place of supply"
        flagged={flagged.has('placeOfSupply')}
      >
        <TextField
          id="field-place-of-supply"
          value={fields.placeOfSupply}
          onChange={(next) => set('placeOfSupply', next)}
        />
      </FieldRow>

      <div className="rule-b bg-paper-raised px-[14px] py-2.5">
        <h3 className="eyebrow">Value and tax</h3>
      </div>

      <FieldRow id="field-taxable" label="Taxable value" flagged={flagged.has('subTotal')}>
        <AmountField
          id="field-taxable"
          value={fields.subTotal}
          onChange={(next) => set('subTotal', next)}
        />
      </FieldRow>

      <FieldRow id="field-cgst" label="CGST" flagged={flagged.has('tax.cgst')}>
        <AmountField id="field-cgst" value={fields.tax.cgst} onChange={(next) => setTax('cgst', next)} />
      </FieldRow>

      <FieldRow id="field-sgst" label="SGST" flagged={flagged.has('tax.sgst')}>
        <AmountField id="field-sgst" value={fields.tax.sgst} onChange={(next) => setTax('sgst', next)} />
      </FieldRow>

      <FieldRow
        id="field-igst"
        label="IGST"
        hint="interstate only"
        flagged={flagged.has('tax.igst')}
      >
        <AmountField id="field-igst" value={fields.tax.igst} onChange={(next) => setTax('igst', next)} />
      </FieldRow>

      <FieldRow id="field-total" label="Invoice total" flagged={flagged.has('total')}>
        <AmountField id="field-total" value={fields.total} onChange={(next) => set('total', next)} />
      </FieldRow>

      <FieldGroupRow label="Signature" flagged={flagged.has('hasSignature')}>
        <div className="inline-flex w-fit gap-px bg-rule">
          {(
            [
              { label: 'Signed', value: true },
              { label: 'Not signed', value: false },
              { label: 'Unclear', value: null },
            ] as const
          ).map((option) => (
            <button
              key={option.label}
              type="button"
              aria-pressed={fields.hasSignature === option.value}
              onClick={() => set('hasSignature', option.value)}
              className={`px-2.5 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.08em] transition-colors ${
                fields.hasSignature === option.value
                  ? 'bg-ink text-paper'
                  : 'bg-paper text-ink-soft hover:bg-bar'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </FieldGroupRow>
    </div>
  );
}
