'use client';

import { AmountField, DateField, FieldRow, TextField } from './FieldRow';
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

      <FieldRow label="Vendor" flagged={flagged.has('vendorName')}>
        <TextField value={fields.vendorName} onChange={(next) => set('vendorName', next)} />
      </FieldRow>

      <FieldRow label="GSTIN" hint="15 characters" flagged={flagged.has('gstin')}>
        <TextField
          value={fields.gstin}
          onChange={(next) => set('gstin', next)}
          mono
          uppercase
          maxLength={15}
          placeholder="not printed on the bill"
        />
      </FieldRow>

      <FieldRow label="Invoice no." flagged={flagged.has('invoiceNumber')}>
        <TextField value={fields.invoiceNumber} onChange={(next) => set('invoiceNumber', next)} mono />
      </FieldRow>

      <FieldRow label="Invoice date" flagged={flagged.has('invoiceDate')}>
        <DateField value={fields.invoiceDate} onChange={(next) => set('invoiceDate', next)} />
      </FieldRow>

      <FieldRow label="Place of supply" flagged={flagged.has('placeOfSupply')}>
        <TextField value={fields.placeOfSupply} onChange={(next) => set('placeOfSupply', next)} />
      </FieldRow>

      <div className="rule-b bg-paper-raised px-[14px] py-2.5">
        <h3 className="eyebrow">Value and tax</h3>
      </div>

      <FieldRow label="Taxable value" flagged={flagged.has('subTotal')}>
        <AmountField value={fields.subTotal} onChange={(next) => set('subTotal', next)} />
      </FieldRow>

      <FieldRow label="CGST" flagged={flagged.has('tax.cgst')}>
        <AmountField value={fields.tax.cgst} onChange={(next) => setTax('cgst', next)} />
      </FieldRow>

      <FieldRow label="SGST" flagged={flagged.has('tax.sgst')}>
        <AmountField value={fields.tax.sgst} onChange={(next) => setTax('sgst', next)} />
      </FieldRow>

      <FieldRow label="IGST" hint="interstate only" flagged={flagged.has('tax.igst')}>
        <AmountField value={fields.tax.igst} onChange={(next) => setTax('igst', next)} />
      </FieldRow>

      <FieldRow label="Invoice total" flagged={flagged.has('total')}>
        <AmountField value={fields.total} onChange={(next) => set('total', next)} />
      </FieldRow>

      <FieldRow label="Signature" flagged={flagged.has('hasSignature')}>
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
      </FieldRow>
    </div>
  );
}
