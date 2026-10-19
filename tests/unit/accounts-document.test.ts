import { describe, expect, it } from 'vitest';
import { isEnteredFact, parseTemplate } from '@uk/contracts';
import { longDate, textAmount } from '@uk/accounting';

/** V2-M5a (DEC-063): the closed template grammar and the way amounts and dates read in the wording. */
describe('template grammar', () => {
  it('parses text, lines with their comparative, facts, scalars and tables standing alone', () => {
    const t = parseTemplate('Net book value at {{year:end}}: {{line:B.FA}} ({{year:priorEnd}}: {{line:B.FA:prior}}). Staff: {{fact:employees.average}}.\n{{table:fixedAssets.movements}}');
    expect(t.errors).toEqual([]);
    expect([t.lines, t.facts, t.tables]).toEqual([['B.FA'], ['employees.average'], ['fixedAssets.movements']]);
    expect(t.paragraphs[1]).toEqual({ kind: 'table', key: 'fixedAssets.movements' });
    expect((t.paragraphs[0] as { parts: { kind: string }[] }).parts.map((p) => p.kind)).toEqual(['text', 'scalar', 'text', 'line', 'text', 'scalar', 'text', 'line', 'text', 'fact', 'text']);
  });
  it('refuses unknown constructs, unknown facts and tables, tables inside text, modifiers other than prior, and stray braces', () => {
    const err = (b: string) => parseTemplate(b).errors.join(' | ');
    expect(err('{{#if fact:x}}yes{{/if}}')).toMatch(/unknown construct/);
    expect(err('{{fact:turnover}}')).toMatch(/not a known fact/);
    expect(err('{{table:payroll}}')).toMatch(/not a known table/);
    expect(err('See {{table:fixedAssets.movements}} below')).toMatch(/a table stands on its own paragraph/);
    expect(err('{{line:B.FA:next}}')).toMatch(/unknown construct/);
    expect(err('{{line:lower}}')).toMatch(/not a line key/);
    expect(err('{{year:end:prior}}')).toMatch(/unknown construct/);
    expect(err('{{company:director}}')).toMatch(/unknown construct/);
    expect(err('Open {{year:end and never closed')).toMatch(/unclosed or stray placeholder/);
    expect(err('<b>bold</b> is only text')).toBe('');                   // no markup is interpreted: it is plain text
  });
  it('the facts a preparer may enter: the four named ones and free wording under text.', () => {
    for (const k of ['employees.average', 'employees.averagePrior', 'approval.date', 'approval.director', 'text.goingConcern']) expect(isEnteredFact(k), k).toBe(true);
    for (const k of ['turnover', 'text.', 'text.going-concern', 'employees.total']) expect(isEnteredFact(k), k).toBe(false);
  });
});

describe('amounts and dates in the wording', () => {
  it('two decimals, thousands separators, a minus sign; dates in full', () => {
    expect(['0', '1234.5', '-1700', '1234567.891', '-0.004'].map(textAmount)).toEqual(['0.00', '1,234.50', '-1,700.00', '1,234,567.89', '-0.00']);
    expect([longDate('2026-12-31'), longDate('2027-03-01')]).toEqual(['31 December 2026', '1 March 2027']);
  });
});
