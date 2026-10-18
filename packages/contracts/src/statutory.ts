import { z } from 'zod';
import { ALL_SUBTYPES, REPORT_LINES } from './ledger';
import { ruleSourceSchema } from './vat';

/**
 * V2-M1 reporting framework (DEC-052, DEC-053, DEC-055): request shapes for standards, their versions and content, the framework a company reports
 * under per financial year, account overrides and the statutory preview; and the closed expression grammar of validation rules (v2-plan 3.3).
 * No standard content is defined here or anywhere in the code: firms enter it with its source and a second person verifies it.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'Invalid date');
const uuid = z.string().uuid();
const flag = z.enum(['true', 'false']).optional().transform((v) => v !== 'false');

export const ENTITY_SIZES = ['MICRO', 'SMALL', 'MEDIUM', 'LARGE'] as const;
export type EntitySize = (typeof ENTITY_SIZES)[number];
export const STATUTORY_LINE_KINDS = ['ACCOUNTS', 'TOTAL', 'RETAINED_PROFIT'] as const;
export const STANDARD_VERSION_STATUSES = ['UNVERIFIED', 'VERIFIED', 'SUPERSEDED'] as const;

export const LINE_KEY = /^[A-Z0-9][A-Z0-9_.-]{0,79}$/;
const lineKey = z.string().trim().regex(LINE_KEY, 'Upper-case letters, digits, dot, dash or underscore (up to 80)');
const sizes = z.array(z.enum(ENTITY_SIZES)).min(1).max(4).refine((a) => new Set(a).size === a.length, 'Each size once');
const reason = z.string().trim().min(3).max(500);

export const createStandardSchema = z.object({
  code: z.string().trim().regex(/^[A-Z0-9][A-Z0-9_-]{1,23}$/, 'Upper-case code such as FRS105 or FRS102-1A'),
  name: z.string().trim().min(1).max(200),
}).strict();

const versionFields = {
  label: z.string().trim().min(1).max(100),
  effectiveFrom: isoDate,
  effectiveTo: isoDate.optional(),
  /** The standard or instrument the content is taken from (DEC-052): URL, instrument and paragraph, the date it was read. */
  source: ruleSourceSchema,
  notes: z.string().trim().max(2000).optional(),
};
const datesInOrder = (r: { effectiveFrom?: string; effectiveTo?: string | null }) => !r.effectiveTo || !r.effectiveFrom || r.effectiveTo >= r.effectiveFrom;
export const createStandardVersionSchema = z.object({ ...versionFields, copyFromVersionId: uuid.optional() }).strict()
  .refine(datesInOrder, { message: 'effectiveTo cannot precede effectiveFrom', path: ['effectiveTo'] });
export const updateStandardVersionSchema = z.object({
  label: versionFields.label.optional(), effectiveFrom: isoDate.optional(), effectiveTo: isoDate.nullable().optional(),
  source: ruleSourceSchema.optional(), notes: z.string().trim().max(2000).nullable().optional(),
}).strict().refine((v) => Object.keys(v).length > 0, 'Nothing to change').refine(datesInOrder, { message: 'effectiveTo cannot precede effectiveFrom', path: ['effectiveTo'] });
/** A change to a verified version: the new version's dates and source, plus why it changes. Its content is copied from the old one, then edited. */
export const supersedeStandardVersionSchema = z.object({ ...versionFields, reason: z.string().trim().min(10).max(1000) }).strict()
  .refine(datesInOrder, { message: 'effectiveTo cannot precede effectiveFrom', path: ['effectiveTo'] });
export const verifyStandardVersionSchema = z.object({ /** What was checked and against what. */ notes: z.string().trim().min(10).max(1000) }).strict();

// ───── Version content ─────
export const formulaTermSchema = z.object({ line: lineKey, sign: z.union([z.literal(1), z.literal(-1)]) }).strict();
const lineFields = {
  statement: z.enum(['PL', 'BS']),
  parentKey: lineKey.nullable().optional(),
  sort: z.number().int().min(0).max(100000).default(0),
  name: z.string().trim().min(1).max(300),
  kind: z.enum(STATUTORY_LINE_KINDS),
  naturalSide: z.enum(['DEBIT', 'CREDIT']).nullable().optional(),
  /** A TOTAL: the signed lines it adds up (DEC-055). */
  formula: z.array(formulaTermSchema).min(1).max(200).nullable().optional(),
};
export interface LineShape { key: string; kind: string; naturalSide?: string | null; formula?: { line: string; sign: number }[] | null; parentKey?: string | null }
/** The shape rules of a line, shared by create and by the merged result of an update (the database repeats them). */
export function lineShapeErrors(l: LineShape): string[] {
  const e: string[] = [];
  if (l.kind === 'TOTAL' && !l.formula?.length) e.push('A TOTAL line needs a formula');
  if (l.kind === 'TOTAL' && l.naturalSide) e.push('A TOTAL line has no natural side');
  if (l.kind !== 'TOTAL' && l.formula) e.push('Only a TOTAL line has a formula');
  if (l.kind !== 'TOTAL' && !l.naturalSide) e.push('An accounts or retained-profit line needs its natural side');
  if (l.formula?.some((t) => t.line === l.key)) e.push('A total cannot include itself');
  if (l.parentKey === l.key) e.push('A line cannot be its own parent');
  return e;
}
export const createStatutoryLineSchema = z.object({ key: lineKey, ...lineFields }).strict().superRefine((l, ctx) => { for (const m of lineShapeErrors(l)) ctx.addIssue({ code: 'custom', message: m }); });
export const updateStatutoryLineSchema = z.object({
  statement: lineFields.statement.optional(), parentKey: lineFields.parentKey, sort: z.number().int().min(0).max(100000).optional(), name: lineFields.name.optional(),
  kind: lineFields.kind.optional(), naturalSide: lineFields.naturalSide, formula: lineFields.formula,
}).strict().refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export const createMapEntrySchema = z.object({
  /** A V1 reporting line (ADR-48) ... */
  sourceLine: z.string().refine((s) => Object.prototype.hasOwnProperty.call(REPORT_LINES, s), 'Unknown V1 reporting line'),
  /** ... optionally narrowed to accounts of one subtype. */
  accountSubtype: z.string().refine((s) => ALL_SUBTYPES.includes(s), 'Unknown subtype').nullable().optional(),
  targetKey: lineKey,
}).strict();
export const updateMapEntrySchema = z.object({ targetKey: lineKey }).strict();

export const createValidationRuleSchema = z.object({
  key: lineKey, description: z.string().trim().min(3).max(500), severity: z.enum(['ERROR', 'WARNING']).default('ERROR'),
  appliesTo: sizes.default([...ENTITY_SIZES]), expression: z.record(z.unknown()),
}).strict();
export const updateValidationRuleSchema = z.object({
  description: z.string().trim().min(3).max(500).optional(), severity: z.enum(['ERROR', 'WARNING']).optional(), appliesTo: sizes.optional(), expression: z.record(z.unknown()).optional(),
}).strict().refine((v) => Object.keys(v).length > 0, 'Nothing to change');

const factKey = z.string().regex(/^[a-z][a-zA-Z0-9_.]{0,79}$/, 'A fact key such as directors.advances or employees.average');
/** What a note needs: lines of the version and named facts (V2-M5 renders the note; V2-M1 stores and shape-checks it). */
export const disclosureRequiresSchema = z.object({ lines: z.array(lineKey).max(100).optional(), facts: z.array(factKey).max(100).optional() }).strict();
export const createDisclosureRuleSchema = z.object({
  key: lineKey, title: z.string().trim().min(3).max(300), appliesTo: sizes.default([...ENTITY_SIZES]), requires: disclosureRequiresSchema.default({}),
}).strict();
export const updateDisclosureRuleSchema = z.object({ title: z.string().trim().min(3).max(300).optional(), appliesTo: sizes.optional(), requires: disclosureRequiresSchema.optional() })
  .strict().refine((v) => Object.keys(v).length > 0, 'Nothing to change');

// ───── Per company ─────
export const setReportingFrameworkSchema = z.object({
  yearStart: isoDate, yearEnd: isoDate, versionId: uuid, entitySize: z.enum(ENTITY_SIZES), reason,
}).strict().refine((f) => f.yearEnd > f.yearStart, { message: 'yearEnd must follow yearStart', path: ['yearEnd'] });
export const setStatutoryOverrideSchema = z.object({ versionId: uuid, accountId: uuid, targetKey: lineKey, reason }).strict();
export const endStatutoryOverrideSchema = z.object({ reason }).strict();
export const statutoryOverrideListQuerySchema = z.object({ versionId: uuid.optional(), includeEnded: z.enum(['true', 'false']).optional().transform((v) => v === 'true') }).strict();
export const statutoryPreviewQuerySchema = z.object({ yearStart: isoDate, compare: flag }).strict();

// ───── Expression grammar (v2-plan 3.3; DEC-053): JSON only, exact decimals, no other construct exists ─────
export type NumExpr = { line: string } | { const: string } | { add: NumExpr[] } | { sub: [NumExpr, NumExpr] } | { neg: NumExpr };
export type CmpOp = 'eq' | 'ge' | 'le' | 'gt' | 'lt';
export type BoolExpr = ({ [K in CmpOp]: { [P in K]: [NumExpr, NumExpr] } & { tolerance?: string } }[CmpOp]) | { and: BoolExpr[] } | { or: BoolExpr[] };
export const COMPARISONS: readonly CmpOp[] = ['eq', 'ge', 'le', 'gt', 'lt'];
/** Ledger scale (Decimal(19,4)): with at most 15 integer digits and 4 decimals every value stays within the 20 significant digits the decimal arithmetic keeps exactly. */
export const DECIMAL = /^-?\d{1,15}(\.\d{1,4})?$/;
const MAX_DEPTH = 32, MAX_NODES = 500;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/**
 * Checks an expression against the grammar: the top level must be a condition; every node has exactly one construct; constants and tolerances are
 * decimal strings; `lineKeys`, when given, are the lines of the version and any other reference is refused. Returns the problems (empty = valid).
 */
export function checkExpression(expr: unknown, lineKeys?: ReadonlySet<string>): string[] {
  const errors: string[] = [];
  let nodes = 0;
  const num = (e: unknown, path: string, depth: number): void => {
    if (++nodes > MAX_NODES) { if (nodes === MAX_NODES + 1) errors.push(`more than ${MAX_NODES} nodes`); return; }
    if (depth > MAX_DEPTH) { errors.push(`${path}: nested deeper than ${MAX_DEPTH}`); return; }
    if (!isObj(e)) { errors.push(`${path}: a value must be an object`); return; }
    const keys = Object.keys(e);
    if (keys.length !== 1) { errors.push(`${path}: a value has exactly one of line, const, add, sub, neg`); return; }
    const k = keys[0]!, v = e[k];
    switch (k) {
      case 'line':
        if (typeof v !== 'string' || !LINE_KEY.test(v)) errors.push(`${path}.line: a line key`);
        else if (lineKeys && !lineKeys.has(v)) errors.push(`${path}.line: ${v} is not a line of this version`);
        return;
      case 'const': if (typeof v !== 'string' || !DECIMAL.test(v)) errors.push(`${path}.const: a decimal string`); return;
      case 'add':
        if (!Array.isArray(v) || v.length < 1 || v.length > 100) { errors.push(`${path}.add: a list of 1 to 100 values`); return; }
        v.forEach((x, i) => num(x, `${path}.add[${i}]`, depth + 1)); return;
      case 'sub':
        if (!Array.isArray(v) || v.length !== 2) { errors.push(`${path}.sub: exactly two values`); return; }
        v.forEach((x, i) => num(x, `${path}.sub[${i}]`, depth + 1)); return;
      case 'neg': num(v, `${path}.neg`, depth + 1); return;
      default: errors.push(`${path}: unknown construct ${k}`);
    }
  };
  const bool = (e: unknown, path: string, depth: number): void => {
    if (++nodes > MAX_NODES) { if (nodes === MAX_NODES + 1) errors.push(`more than ${MAX_NODES} nodes`); return; }
    if (depth > MAX_DEPTH) { errors.push(`${path}: nested deeper than ${MAX_DEPTH}`); return; }
    if (!isObj(e)) { errors.push(`${path}: a condition must be an object`); return; }
    const keys = Object.keys(e);
    const op = keys.find((k) => (COMPARISONS as readonly string[]).includes(k));
    if (op) {
      const extra = keys.filter((k) => k !== op && k !== 'tolerance');
      if (extra.length) { errors.push(`${path}: unknown construct ${extra.join(', ')}`); return; }
      const tol = e.tolerance;
      if (tol !== undefined && (typeof tol !== 'string' || !DECIMAL.test(tol) || tol.startsWith('-'))) errors.push(`${path}.tolerance: a non-negative decimal string`);
      const args = e[op];
      if (!Array.isArray(args) || args.length !== 2) { errors.push(`${path}.${op}: exactly two values`); return; }
      args.forEach((x, i) => num(x, `${path}.${op}[${i}]`, depth + 1));
      return;
    }
    const unknown = keys.filter((k) => !['and', 'or', 'line', 'const', 'add', 'sub', 'neg', 'tolerance'].includes(k));
    if (unknown.length) { errors.push(`${path}: unknown construct ${unknown.join(', ')}`); return; }
    if (keys.length !== 1 || (keys[0] !== 'and' && keys[0] !== 'or')) {
      errors.push(`${path}: a condition is one of ${COMPARISONS.join(', ')}, and, or` + (keys.some((k) => ['line', 'const', 'add', 'sub', 'neg'].includes(k)) ? ' (a value is not a condition)' : ''));
      return;
    }
    const list = e[keys[0]];
    if (!Array.isArray(list) || list.length < 1 || list.length > 100) { errors.push(`${path}.${keys[0]}: a list of 1 to 100 conditions`); return; }
    list.forEach((x, i) => bool(x, `${path}.${keys[0]}[${i}]`, depth + 1));
  };
  bool(expr, '$', 0);
  return errors;
}
/** The line keys an expression refers to. */
export function expressionLines(expr: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(expr)) for (const x of expr) expressionLines(x, out);
  else if (isObj(expr)) for (const [k, v] of Object.entries(expr)) { if (k === 'line' && typeof v === 'string') out.add(v); else expressionLines(v, out); }
  return out;
}
