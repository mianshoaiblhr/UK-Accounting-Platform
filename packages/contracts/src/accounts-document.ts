import { z } from 'zod';

/**
 * V2-M5a (DEC-063): the accounts document. Wording is version content (disclosure rules) written in a closed template grammar: text with
 * placeholders, no code, no expressions, no markup. The output is text and tables only.
 */
export const DOCUMENT_SECTIONS = ['POLICIES', 'NOTES', 'DIRECTORS_REPORT', 'BALANCE_SHEET_STATEMENTS'] as const;
export type DocumentSection = (typeof DOCUMENT_SECTIONS)[number];
/** Tables the platform draws from the ledger and the registers. */
export const TABLE_FACTS = ['fixedAssets.movements', 'provisions.movements', 'directors.advances', 'relatedParties.transactions'] as const;
/** Facts the preparer enters for a framework year, besides free wording under `text.*`; the `size.*` facts are read by the size test (V2-M5b). */
export const ENTERED_FACTS = ['employees.average', 'employees.averagePrior', 'approval.date', 'approval.director', 'size.priorMet', 'size.priorStatus'] as const;
const TEXT_FACT = /^text\.[a-zA-Z][a-zA-Z0-9]{0,39}$/;
export const isEnteredFact = (k: string) => (ENTERED_FACTS as readonly string[]).includes(k) || TEXT_FACT.test(k);
const SCALARS: Record<string, readonly string[]> = { company: ['name', 'number'], year: ['start', 'end', 'priorEnd'], standard: ['name'], version: ['label'], directors: ['names'] };

export type TemplatePart = { kind: 'text'; text: string } | { kind: 'line'; key: string; prior: boolean } | { kind: 'fact'; key: string } | { kind: 'scalar'; scope: string; key: string };
export type TemplateParagraph = { kind: 'table'; key: string } | { kind: 'text'; parts: TemplatePart[] };
export interface ParsedTemplate { paragraphs: TemplateParagraph[]; errors: string[]; lines: string[]; facts: string[]; tables: string[] }

const TOKEN = /\{\{([^{}]*)\}\}/g;
/** Parses a body template. Unknown constructs are errors; line keys are checked against the version by the caller. */
export function parseTemplate(body: string): ParsedTemplate {
  const out: ParsedTemplate = { paragraphs: [], errors: [], lines: [], facts: [], tables: [] };
  for (const para of body.split('\n')) {
    const table = /^\{\{table:([A-Za-z0-9_.]+)\}\}$/.exec(para.trim());
    if (table) {
      if ((TABLE_FACTS as readonly string[]).includes(table[1]!)) { out.paragraphs.push({ kind: 'table', key: table[1]! }); out.tables.push(table[1]!); }
      else out.errors.push(`{{table:${table[1]}}} is not a known table`);
      continue;
    }
    const parts: TemplatePart[] = [];
    let last = 0;
    for (const m of para.matchAll(TOKEN)) {
      if (m.index! > last) parts.push({ kind: 'text', text: para.slice(last, m.index) });
      last = m.index! + m[0].length;
      const [scope, key, modifier, ...extra] = m[1]!.split(':');
      const bad = (why: string) => out.errors.push(`{{${m[1]}}}: ${why}`);
      if (extra.length || !key) { bad('unknown construct'); continue; }
      if (scope === 'line') {
        if (!/^[A-Z0-9][A-Z0-9_.-]{0,79}$/.test(key)) { bad('not a line key'); continue; }
        if (modifier !== undefined && modifier !== 'prior') { bad('unknown construct'); continue; }
        parts.push({ kind: 'line', key, prior: modifier === 'prior' }); out.lines.push(key);
      } else if (modifier !== undefined) bad('unknown construct');
      else if (scope === 'fact') {
        if (!isEnteredFact(key)) { bad('not a known fact'); continue; }
        parts.push({ kind: 'fact', key }); out.facts.push(key);
      } else if (scope === 'table') bad('a table stands on its own paragraph');
      else if (scope && SCALARS[scope]?.includes(key)) parts.push({ kind: 'scalar', scope, key });
      else bad('unknown construct');
    }
    if (last < para.length) parts.push({ kind: 'text', text: para.slice(last) });
    // a brace left over means a placeholder that is not closed or not opened
    for (const p of parts) if (p.kind === 'text' && /\{\{|\}\}/.test(p.text)) out.errors.push(`"${p.text.trim().slice(0, 40)}": an unclosed or stray placeholder`);
    out.paragraphs.push({ kind: 'text', parts });
  }
  out.lines = [...new Set(out.lines)]; out.facts = [...new Set(out.facts)]; out.tables = [...new Set(out.tables)];
  return out;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'Invalid date');
export const accountsDocumentQuerySchema = z.object({ yearStart: isoDate }).strict();
export const accountsFactQuerySchema = z.object({ yearStart: isoDate }).strict();
export const setAccountsFactSchema = z.object({
  yearStart: isoDate,
  key: z.string().refine(isEnteredFact, 'Not a known fact: employees.average, employees.averagePrior, approval.date, approval.director, size.priorMet, size.priorStatus or text.<name>'),
  value: z.string().trim().min(1).max(5000),
  reason: z.string().trim().min(3).max(500),
}).strict();
