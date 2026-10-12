import { describe, expect, it } from 'vitest';
import { bankDetailsSchema, createContactRoleSchema, isValidIban, updateContactRoleSchema, vatNumberSchema } from '@uk/contracts';

/** V1-M4a request rules that need no database. Bank details here are synthetic test values. */
describe('IBAN check (ISO 13616 mod-97)', () => {
  it('accepts well-formed IBANs and rejects a wrong checksum, bad structure or a short value', () => {
    expect(isValidIban('GB82 WEST 1234 5698 7654 32')).toBe(true);           // the standard published example
    expect(isValidIban('DE89370400440532013000')).toBe(true);
    expect(isValidIban('GB82WEST12345698765433')).toBe(false);              // one digit changed
    expect(isValidIban('GB82-WEST-1234')).toBe(false);
    expect(isValidIban('1234')).toBe(false);
  });
});

describe('bank details', () => {
  const ok = { accountName: 'Synthetic Supplies Ltd', sortCode: '12-34-56', accountNumber: '12345678', reason: 'Supplier letter dated 1 March' };
  it('normalises the sort code, needs UK details or an IBAN, and a reason of at least 10 characters', () => {
    expect(bankDetailsSchema.parse(ok).sortCode).toBe('123456');
    expect(bankDetailsSchema.safeParse({ ...ok, reason: 'short' }).success).toBe(false);
    expect(bankDetailsSchema.safeParse({ accountName: 'X', reason: 'No details at all here' }).success).toBe(false);
    expect(bankDetailsSchema.safeParse({ accountName: 'X', sortCode: '123456', reason: 'Sort code without account' }).success).toBe(false);
    expect(bankDetailsSchema.safeParse({ ...ok, accountNumber: '1234567' }).success).toBe(false);
    expect(bankDetailsSchema.safeParse({ accountName: 'X', iban: 'GB82 WEST 1234 5698 7654 32', bic: 'WESTGB2L', reason: 'International supplier' }).success).toBe(true);
    expect(bankDetailsSchema.safeParse({ accountName: 'X', iban: 'GB82WEST12345698765433', reason: 'Bad checksum given' }).success).toBe(false);
    expect(bankDetailsSchema.safeParse({ ...ok, bic: 'NOTABIC' }).success).toBe(false);
  });
});

describe('VAT numbers (format only)', () => {
  it('normalises spaces and case; accepts GB/XI 9 or 12 digits and EU-style numbers; rejects the rest', () => {
    expect(vatNumberSchema.parse('gb 123 4567 89')).toBe('GB123456789');
    expect(vatNumberSchema.parse('GB123456789012')).toBe('GB123456789012');
    expect(vatNumberSchema.parse('XI123456789')).toBe('XI123456789');
    expect(vatNumberSchema.parse('DE123456789')).toBe('DE123456789');
    for (const bad of ['GB12345678', 'GB1234567890', 'GB12', '123456789', 'G1', 'DE1234567']) expect(vatNumberSchema.safeParse(bad).success, bad).toBe(false);
  });
});

describe('role requests', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  it('credit limits are for customers, default expense accounts for suppliers; terms 0-365 days; amounts are strings', () => {
    expect(createContactRoleSchema.safeParse({ contactId: id, role: 'CUSTOMER', creditLimit: '5000.00' }).success).toBe(true);
    expect(createContactRoleSchema.safeParse({ contactId: id, role: 'SUPPLIER', creditLimit: '5000.00' }).success).toBe(false);
    expect(createContactRoleSchema.safeParse({ contactId: id, role: 'CUSTOMER', defaultExpenseAccountId: id }).success).toBe(false);
    expect(createContactRoleSchema.safeParse({ contactId: id, role: 'CUSTOMER', paymentTermsDays: 366 }).success).toBe(false);
    expect(createContactRoleSchema.safeParse({ contactId: id, role: 'CUSTOMER', creditLimit: 5000 }).success).toBe(false);
    expect(createContactRoleSchema.safeParse({ contactId: id, role: 'CUSTOMER', accountCode: 'has space' }).success).toBe(false);
    expect(updateContactRoleSchema.safeParse({ reason: 'only a reason' }).success).toBe(false);
  });
});
