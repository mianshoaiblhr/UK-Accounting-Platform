import { z } from 'zod';

/**
 * V3-M1 (DEC-093): the taxonomy and its mapping. A taxonomy version names the entry point and the namespace of each prefix it uses; its
 * concept map says which concept tags each statutory line, preparer's fact or company detail, with the period type, sign, decimals and
 * dimensions. All of it is versioned organisation data, verified by a second person before use (the DEC-021 pattern); NO concept, namespace
 * or entry point is written in application code (V3 specification, "Never scatter taxonomy tags").
 */
export const XBRL_SOURCE_KINDS = ['LINE', 'FACT', 'COMPANY'] as const;
export type XbrlSourceKind = (typeof XBRL_SOURCE_KINDS)[number];
/** The company details an entry may tag (read from the approved accounts package in V3-M2). */
export const XBRL_COMPANY_KEYS = ['company.name', 'company.number', 'period.start', 'period.end', 'balanceSheetDate', 'directors', 'approval.director', 'approval.date'] as const;
export const XBRL_DATA_TYPES = ['MONETARY', 'TEXT', 'DATE'] as const;
export const XBRL_PERIOD_TYPES = ['INSTANT', 'DURATION'] as const;
export const TAXONOMY_STATUSES = ['UNVERIFIED', 'VERIFIED', 'SUPERSEDED'] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'Invalid date');
const httpUrl = z.string().trim().url().max(500).refine((u) => /^https?:\/\//.test(u), 'An http(s) link');
const PREFIX = /^[a-z][a-z0-9-]{0,19}$/;
/** A qualified name: a declared prefix and a local name (checked against the version's namespaces by `mappingProblems`). */
const QNAME = /^[a-z][a-z0-9-]{0,19}:[A-Za-z_][A-Za-z0-9_.-]{0,199}$/;
const source = z.object({ url: httpUrl, provision: z.string().trim().min(3).max(300), retrievedOn: isoDate }).strict();
const namespaces = z.record(z.string().regex(PREFIX, 'A prefix: lower case letters, digits and hyphens'), httpUrl).refine((n) => Object.keys(n).length >= 1 && Object.keys(n).length <= 30, 'Between 1 and 30 namespaces');
const dates = <T extends { effectiveFrom?: string; effectiveTo?: string | null }>(v: T) => !v.effectiveFrom || !v.effectiveTo || v.effectiveTo >= v.effectiveFrom;

export const createTaxonomyVersionSchema = z.object({
  label: z.string().trim().min(3).max(200), standardCode: z.string().trim().min(2).max(40), entryPoint: httpUrl, namespaces,
  effectiveFrom: isoDate, effectiveTo: isoDate.optional(), source, notes: z.string().trim().max(4000).optional(), copyFromVersionId: z.string().uuid().optional(),
}).strict().refine(dates, { message: 'The end is on or after the start', path: ['effectiveTo'] });
export const updateTaxonomyVersionSchema = z.object({
  label: z.string().trim().min(3).max(200).optional(), entryPoint: httpUrl.optional(), namespaces: namespaces.optional(),
  effectiveFrom: isoDate.optional(), effectiveTo: isoDate.nullable().optional(), source: source.optional(), notes: z.string().trim().max(4000).nullable().optional(),
}).strict().refine(dates, { message: 'The end is on or after the start', path: ['effectiveTo'] });
export const verifyTaxonomyVersionSchema = z.object({ notes: z.string().trim().min(10).max(4000) }).strict();
export const supersedeTaxonomyVersionSchema = z.object({
  label: z.string().trim().min(3).max(200), effectiveFrom: isoDate, effectiveTo: isoDate.optional(), source, notes: z.string().trim().max(4000).optional(), reason: z.string().trim().min(10).max(1000),
}).strict().refine(dates, { message: 'The end is on or after the start', path: ['effectiveTo'] });

export const conceptEntrySchema = z.object({
  sourceKind: z.enum(XBRL_SOURCE_KINDS), sourceKey: z.string().trim().min(1).max(100),
  concept: z.string().trim().regex(QNAME, 'A concept: prefix:LocalName'), dataType: z.enum(XBRL_DATA_TYPES), periodType: z.enum(XBRL_PERIOD_TYPES),
  negate: z.boolean().default(false), decimals: z.number().int().min(-6).max(6).nullable().default(null),
  dimensions: z.array(z.object({ axis: z.string().regex(QNAME), member: z.string().regex(QNAME) }).strict()).max(5).default([]),
  mandatory: z.boolean().default(false),
}).strict()
  .refine((e) => e.dataType !== 'MONETARY' || e.decimals !== null, { message: 'A monetary concept needs its decimals', path: ['decimals'] })
  .refine((e) => e.dataType === 'MONETARY' || (e.decimals === null && !e.negate), { message: 'Only a monetary concept has decimals or a sign rule', path: ['dataType'] });
export type ConceptEntry = z.output<typeof conceptEntrySchema>;
export const taxonomyListQuerySchema = z.object({ standardCode: z.string().trim().min(2).max(40).optional(), includeSuperseded: z.enum(['true', 'false']).optional().transform((v) => v === 'true') }).strict();

/**
 * What stops a taxonomy version from being verified (DEC-093); empty when it may be. Prefixes must be declared; a monetary entry has decimals
 * and the others have neither decimals nor negation; a company detail must be one the platform knows; a version must map something.
 */
export function mappingProblems(v: { namespaces: Record<string, string> }, entries: Pick<ConceptEntry, 'sourceKind' | 'sourceKey' | 'concept' | 'dataType' | 'negate' | 'decimals' | 'dimensions'>[]): string[] {
  const out: string[] = [];
  const declared = (q: string) => Object.prototype.hasOwnProperty.call(v.namespaces, q.split(':')[0]!);
  if (entries.length === 0) out.push('the version maps nothing');
  for (const e of entries) {
    const at = `${e.sourceKind} ${e.sourceKey}`;
    for (const q of [e.concept, ...e.dimensions.flatMap((d) => [d.axis, d.member])]) if (!declared(q)) out.push(`${at}: the prefix of ${q} is not declared`);
    if (e.dataType === 'MONETARY' && e.decimals === null) out.push(`${at}: a monetary concept needs its decimals`);
    if (e.dataType !== 'MONETARY' && (e.decimals !== null || e.negate)) out.push(`${at}: only a monetary concept has decimals or a sign rule`);
    if (e.sourceKind === 'COMPANY' && !(XBRL_COMPANY_KEYS as readonly string[]).includes(e.sourceKey)) out.push(`${at}: not a company detail the platform knows (${XBRL_COMPANY_KEYS.join(', ')})`);
  }
  return out;
}
