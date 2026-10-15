import { describe, expect, it } from 'vitest';
import { statementMappingSchema, type StatementMapping } from '@uk/contracts';
import { decodeStatement, fingerprintLines, parseCsv, parseStatement, parseStatementAmount, parseStatementDate } from '@uk/platform';

/** V1-M7a statement parsing (DEC-040): the CSV reader, dates, amounts, the all-or-nothing row checks, balance proof and fingerprints. Synthetic data. */
const map = (m: Partial<StatementMapping> & Record<string, unknown>) => statementMappingSchema.parse({ dateColumn: 'Date', dateFormat: 'DD/MM/YYYY', descriptionColumn: 'Description', amountColumn: 'Amount', ...m });
const run = (csv: string, m: Partial<StatementMapping> & Record<string, unknown> = {}, o: { today?: string; openingDate?: string } = {}) =>
  parseStatement(parseCsv(csv), map(m), { minor: 2, today: o.today ?? '2026-10-15', openingDate: o.openingDate });

describe('CSV reader (RFC 4180)', () => {
  it('quotes, doubled quotes, delimiters and line breaks inside quotes, CRLF, a byte-order mark, a missing final newline', () => {
    expect(parseCsv('﻿a,"b, c","say ""hi"""\r\n1,"two\nlines",3')).toEqual([['a', 'b, c', 'say "hi"'], ['1', 'two\nlines', '3']]);
    expect(parseCsv('x;y\n1;2\n', ';')).toEqual([['x', 'y'], ['1', '2']]);
    expect(parseCsv('a,,c\n')).toEqual([['a', '', 'c']]);
  });
  it('decodes UTF-8, and Windows-1252 when the bytes are not UTF-8 (a pound sign from an older export)', () => {
    expect(decodeStatement(Buffer.from('£5', 'utf8'))).toBe('£5');
    expect(decodeStatement(Buffer.from([0xa3, 0x35]))).toBe('£5');
  });
});

describe('dates and amounts', () => {
  it('reads each declared date format and refuses impossible dates', () => {
    expect(parseStatementDate('05/03/2026', 'DD/MM/YYYY')).toBe('2026-03-05');
    expect(parseStatementDate('5/3/26', 'DD/MM/YY')).toBe('2026-03-05');
    expect(parseStatementDate('03/05/2026', 'MM/DD/YYYY')).toBe('2026-03-05');
    expect(parseStatementDate('2026-03-05', 'YYYY-MM-DD')).toBe('2026-03-05');
    expect(parseStatementDate('05-03-2026', 'DD-MM-YYYY')).toBe('2026-03-05');
    expect(parseStatementDate('5 March 2026', 'DD MMM YYYY')).toBe('2026-03-05');
    expect(parseStatementDate('05-Mar-2026', 'DD MMM YYYY')).toBe('2026-03-05');
    expect(parseStatementDate('31/02/2026', 'DD/MM/YYYY')).toBeNull();
    expect(parseStatementDate('2026-03-05', 'DD/MM/YYYY')).toBeNull();
  });
  it('reads signs, currency symbols, thousands separators and parentheses; refuses extra decimals and text', () => {
    expect(parseStatementAmount('£1,234.50', 2)).toBe('1234.50');
    expect(parseStatementAmount('-12', 2)).toBe('-12.00');
    expect(parseStatementAmount('(12.30)', 2)).toBe('-12.30');
    expect(parseStatementAmount('12.30-', 2)).toBe('-12.30');
    expect(parseStatementAmount('+0.5', 2)).toBe('0.50');
    expect(parseStatementAmount('', 2)).toBeNull();
    expect(parseStatementAmount('1.234', 2)).toBeUndefined();
    expect(parseStatementAmount('12a', 2)).toBeUndefined();
    expect(parseStatementAmount('100', 0)).toBe('100');
  });
});

describe('statement rows (all or nothing)', () => {
  it('a header file with a running balance, newest first, is put in date order and proved line by line', () => {
    const r = run('Date,Description,Amount,Balance,Ref\n03/03/2026,CARD SHOP,-20.00,130.00,\n02/03/2026,"ACME LTD, INV-1",100.00,150.00,INV-1\n01/03/2026,OPENING CREDIT,50.00,50.00,',
      { balanceColumn: 'Balance', referenceColumn: 'Ref' });
    expect(r.errors).toEqual([]);
    expect(r.lines.map((l) => [l.date, l.amount, l.balance, l.reference, l.sourceRow])).toEqual([
      ['2026-03-01', '50.00', '50.00', null, 4], ['2026-03-02', '100.00', '150.00', 'INV-1', 3], ['2026-03-03', '-20.00', '130.00', null, 2]]);
  });
  it('a wrong balance fails the whole file at the row where the proof breaks', () => {
    const r = run('Date,Description,Amount,Balance\n01/03/2026,A,10.00,10.00\n02/03/2026,B,5.00,16.00\n03/03/2026,C,1.00,17.00', { balanceColumn: 'Balance' });
    expect(r.lines).toEqual([]);
    expect(r.errors).toEqual([{ row: 3, message: expect.stringMatching(/running balance/) }]);
  });
  it('separate money-in and money-out columns; zeros in the unused column are ignored; positions instead of names without a header', () => {
    const r = parseStatement(parseCsv('2026-03-01,Salary,1500.00,0.00\n2026-03-02,Rent,,700.00'),
      statementMappingSchema.parse({ hasHeader: false, dateColumn: 1, dateFormat: 'YYYY-MM-DD', descriptionColumn: 2, moneyInColumn: 3, moneyOutColumn: 4 }), { minor: 2, today: '2026-10-15' });
    expect(r.lines.map((l) => l.amount)).toEqual(['1500.00', '-700.00']);
  });
  it('invertSign flips a bank that exports money out as positive', () => {
    expect(run('Date,Description,Amount\n01/03/2026,Fee,2.50', { invertSign: true }).lines[0]!.amount).toBe('-2.50');
  });
  it('every bad row is reported and nothing is returned: bad date, future, before the opening date, empty description, zero, both columns, extra decimals', () => {
    const r = run('Date,Description,Amount\n32/01/2026,A,1\n01/12/2026,B,1\n01/01/2025,C,1\n02/03/2026,,1\n02/03/2026,D,0\n02/03/2026,E,1.001', {}, { openingDate: '2026-01-01' });
    expect(r.lines).toEqual([]);
    expect(r.errors.map((e) => e.row)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(r.errors.map((e) => e.message)).toEqual([expect.stringMatching(/not a date/), expect.stringMatching(/future/), expect.stringMatching(/before the account's statement opening date/),
      'The description is empty', 'The amount is zero', expect.stringMatching(/at most 2 decimal places/)]);
    const both = parseStatement(parseCsv('Date,Description,In,Out\n01/03/2026,X,1.00,2.00'), map({ amountColumn: undefined, moneyInColumn: 'In', moneyOutColumn: 'Out' }), { minor: 2, today: '2026-10-15' });
    expect(both.errors).toEqual([{ row: 2, message: 'Both money in and money out are filled in' }]);
  });
  it('a missing column is reported once, against the header row; a column named without a header is refused', () => {
    expect(run('Date,Narrative,Amount\n01/03/2026,A,1').errors).toEqual([{ row: 1, message: 'The description column "Description" is not in the header row' }]);
    expect(parseStatement(parseCsv('01/03/2026,A,1'), map({ hasHeader: false }), { minor: 2, today: '2026-10-15' }).errors[0]!.message).toMatch(/no header row/);
  });
  it('the mapping is validated: one amount column or both in/out columns', () => {
    expect(statementMappingSchema.safeParse({ dateColumn: 1, dateFormat: 'DD/MM/YYYY', descriptionColumn: 2 }).success).toBe(false);
    expect(statementMappingSchema.safeParse({ dateColumn: 1, dateFormat: 'DD/MM/YYYY', descriptionColumn: 2, amountColumn: 3, moneyInColumn: 4, moneyOutColumn: 5 }).success).toBe(false);
    expect(statementMappingSchema.safeParse({ dateColumn: 1, dateFormat: 'DD/MM/YYYY', descriptionColumn: 2, moneyInColumn: 4 }).success).toBe(false);
  });
});

describe('fingerprints (DEC-040)', () => {
  it('identical lines in one file differ by occurrence, so both are kept; the same line in an overlapping file has the same print', () => {
    const a = run('Date,Description,Amount\n01/03/2026,COFFEE,-2.50\n01/03/2026,COFFEE,-2.50\n02/03/2026,BUS,-1.75').lines;
    const b = run('Date,Description,Amount\n01/03/2026,coffee ,-2.50\n03/03/2026,TAXI,-9.00').lines;
    const [p, q] = [fingerprintLines('acct-1', a), fingerprintLines('acct-1', b)];
    expect(new Set(p).size).toBe(3);
    expect(q[0]).toBe(p[0]);
    expect(fingerprintLines('acct-2', a)[0]).not.toBe(p[0]);
  });
});
