import { describe, expect, it } from 'vitest';
import { lineAmount, money, releaseShare } from '@uk/accounting';
import { createCreditNoteSchema, createInvoiceSchema, quantityString, salesSettingsSchema } from '@uk/contracts';

/** V1-M5a arithmetic and request rules: line amounts half-up; allocations release carried amounts without residue (DEC-027, DEC-030). */
describe('sales arithmetic', () => {
  it('line amount = quantity x unit price, half-up to the minor units', () => {
    expect(lineAmount(money('3'), money('0.335'), 2).toFixed(2)).toBe('1.01');   // 1.005 -> 1.01
    expect(lineAmount(money('2.5'), money('33.33'), 2).toFixed(2)).toBe('83.33'); // 83.325 -> 83.33
    expect(lineAmount(money('1'), money('0.0049'), 2).toFixed(2)).toBe('0.00');
    expect(lineAmount(money('7'), money('1000'), 0).toFixed(0)).toBe('7000');     // a zero-decimal currency
  });
  it('releases prorate half-up, and the allocation that clears a document releases exactly what is left (no residue whatever the split)', () => {
    for (const [carried, total, parts] of [['850.00', '1000.00', ['400', '333.33', '266.67']], ['283.33', '333.33', ['0.01', '333.31', '0.01']], ['100.00', '3.00', ['1', '1', '1']]] as const) {
      let fo = money(carried), out = money(total), released = money(0);
      for (const p of parts) {
        const r = releaseShare(fo, out, money(p), 2);
        released = released.plus(r); fo = fo.minus(r); out = out.minus(p);
      }
      expect(out.isZero()).toBe(true);
      expect(fo.isZero()).toBe(true);
      expect(released.toFixed(2)).toBe(money(carried).toFixed(2));
    }
    expect(releaseShare(money('850'), money('1000'), money('400'), 2).toFixed(2)).toBe('340.00');
  });
});

describe('sales request rules', () => {
  const line = { description: 'x', unitPrice: '1.00', accountId: '11111111-1111-4111-8111-111111111111' };
  it('quantities and prices are decimal strings; a quantity is positive', () => {
    expect(quantityString.safeParse('0').success).toBe(false);
    expect(quantityString.safeParse('2.5').success).toBe(true);
    expect(createInvoiceSchema.safeParse({ customerRoleId: line.accountId, issueDate: '2026-02-10', lines: [{ ...line, unitPrice: 1 }] }).success).toBe(false);
  });
  it('dates are real and in order; bodies are strict; a credit note needs a reason', () => {
    expect(createInvoiceSchema.safeParse({ customerRoleId: line.accountId, issueDate: '2026-02-30', lines: [line] }).success).toBe(false);
    expect(createInvoiceSchema.safeParse({ customerRoleId: line.accountId, issueDate: '2026-02-10', dueDate: '2026-02-09', lines: [line] }).success).toBe(false);
    expect(createInvoiceSchema.safeParse({ customerRoleId: line.accountId, issueDate: '2026-02-10', lines: [line], number: 5 }).success).toBe(false);
    expect(createCreditNoteSchema.safeParse({ originalInvoiceId: line.accountId, issueDate: '2026-02-10' }).success).toBe(false);
    expect(salesSettingsSchema.safeParse({ receivablesAccountId: null, invoicePrefix: 'INV 2026', reason: 'Configure numbering' }).success).toBe(false);
  });
});
