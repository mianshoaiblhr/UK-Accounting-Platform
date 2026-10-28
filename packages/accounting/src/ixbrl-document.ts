import { createHash } from 'node:crypto';
import { conflict, notFound, unprocessable, forbidden } from '@uk/core';
import type { Tx } from '@uk/db';
import { auditRow } from '@uk/platform';
import { money } from './money';
import { conceptEntryView } from './ixbrl';

/**
 * V3-M2 (DEC-094): the inline XBRL document of an approved accounts package (DEC-070), tagged by a verified taxonomy version (DEC-093). The
 * builder is pure: the same package, mapping, facts and prior year give the same document and the same SHA-256. The namespaces of the inline XBRL
 * specification are fixed here; every taxonomy concept, namespace, entry point and the entity scheme come from the version. Nothing is filed.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
/** The namespaces of the XBRL and inline XBRL specifications (not of a taxonomy); a taxonomy version may not reuse their prefixes. */
const SPEC_NAMESPACES: Record<string, string> = {
  ix: 'http://www.xbrl.org/2013/inlineXBRL', ixt: 'http://www.xbrl.org/inlineXBRL/transformation/2020-02-12', xbrli: 'http://www.xbrl.org/2003/instance',
  link: 'http://www.xbrl.org/2003/linkbase', xlink: 'http://www.w3.org/1999/xlink', xbrldi: 'http://xbrl.org/2006/xbrldi', iso4217: 'http://www.xbrl.org/2003/iso4217',
};
const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const grouped = (abs: string) => { const [i, f] = abs.split('.'); return `${i!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f !== undefined ? `.${f}` : ''}`; };

type Entry = ReturnType<typeof conceptEntryView>;
interface Line { key: string; name: string; amount: string | null; comparative?: string | null }
export interface IxbrlInput {
  taxonomy: { entryPoint: string; entityScheme: string | null; namespaces: Record<string, string>; entries: Entry[] };
  company: { name: string; number: string | null; currency: string };
  year: { start: string; end: string; priorStart: string | null; priorEnd: string };
  approval: { director: string | null; approvedOn: string | null };
  statements: { profitAndLoss: Line[]; balanceSheet: Line[] };
  balanced: boolean;
  sections: { section: string; items: { key: string; title: string; blocks: ({ type: 'text'; text: string } | { type: 'table'; [k: string]: unknown })[] }[] }[];
  facts: Record<string, string>;
}
export interface IxbrlResult { content: string; sha256: string; factCount: number; contextCount: number; errors: string[]; warnings: string[] }

export function buildIxbrl(i: IxbrlInput): IxbrlResult {
  const errors: string[] = [], warnings: string[] = [];
  const ns = i.taxonomy.namespaces;
  for (const p of Object.keys(ns)) if (Object.prototype.hasOwnProperty.call(SPEC_NAMESPACES, p)) errors.push(`The taxonomy version declares the prefix "${p}", which the inline XBRL specification uses`);
  if (!i.company.number) errors.push('The company has no registered number: the entity identifier needs it');
  if (!i.taxonomy.entityScheme) errors.push('The taxonomy version has no entity identifier scheme');
  if (!i.balanced) errors.push('The balance sheet of the approved accounts does not balance');
  if (!/^[A-Z]{3}$/.test(i.company.currency)) errors.push(`The currency ${i.company.currency} is not an ISO 4217 code`);
  const prior = i.year.priorStart ? { start: i.year.priorStart, end: i.year.priorEnd } : null;
  for (const [s, e, what] of [[i.year.start, i.year.end, 'the year'], ...(prior ? [[prior.start, prior.end, 'the prior year']] : [])] as const) if (s > e) errors.push(`The context of ${what} starts after it ends`);

  // contexts: one per period and dimension set, numbered in a fixed order so the same input gives the same document
  const ctxKeys = new Map<string, { period: { instant?: string; start?: string; end?: string }; dims: { axis: string; member: string }[] }>();
  const ctxKey = (e: Entry, which: 'current' | 'prior') => {
    const y = which === 'current' ? i.year : prior!;
    const period = e.periodType === 'INSTANT' ? { instant: y.end } : { start: y.start, end: y.end };
    const dims = [...e.dimensions].sort((a, b) => (a.axis < b.axis ? -1 : 1));
    const k = JSON.stringify([period, dims]);
    if (!ctxKeys.has(k)) ctxKeys.set(k, { period, dims });
    return k;
  };
  interface Fact { entry: Entry; ctx: string; value: string; display: string; negative: boolean }
  const facts: Fact[] = [];
  const byKey = new Map<string, Entry>(i.taxonomy.entries.map((e) => [`${e.sourceKind}|${e.sourceKey}`, e]));
  const monetary = (e: Entry, amount: string | null | undefined, which: 'current' | 'prior') => {
    if (amount === null || amount === undefined) return null;
    let v = money(amount);
    if (e.negate) v = v.negated();
    const f: Fact = { entry: e, ctx: ctxKey(e, which), value: v.toFixed(Math.max(e.decimals ?? 2, 0)), display: grouped(v.abs().toFixed(Math.max(e.decimals ?? 2, 0))), negative: v.isNegative() };
    facts.push(f);
    return f;
  };
  const text = (e: Entry, value: string | null | undefined) => {
    if (value === null || value === undefined || value === '') return null;
    const f: Fact = { entry: e, ctx: ctxKey(e, 'current'), value, display: value, negative: false };
    facts.push(f);
    return f;
  };

  // the statements' facts, then the company details and the preparer's facts
  const lineFacts = new Map<string, { current: Fact | null; prior: Fact | null }>();
  let comparativesLeftOut = false;
  for (const l of [...i.statements.profitAndLoss, ...i.statements.balanceSheet]) {
    const e = byKey.get(`LINE|${l.key}`);
    if (!e) { if (l.amount && !money(l.amount).isZero()) warnings.push(`Line ${l.key} (${l.name}) has an amount but no concept: it is shown untagged`); continue; }
    const hasPrior = l.comparative !== undefined && l.comparative !== null;
    if (hasPrior && !prior) comparativesLeftOut = true;
    lineFacts.set(l.key, { current: monetary(e, l.amount, 'current'), prior: hasPrior && prior ? monetary(e, l.comparative, 'prior') : null });
  }
  if (comparativesLeftOut) warnings.push('Comparatives are shown untagged: the company has no reporting-framework year before this one');
  const company: Record<string, string | null> = {
    'company.name': i.company.name, 'company.number': i.company.number, 'period.start': i.year.start, 'period.end': i.year.end, balanceSheetDate: i.year.end,
    'approval.director': i.approval.director, 'approval.date': i.approval.approvedOn, directors: i.approval.director,
  };
  const detailFacts = new Map<string, Fact | null>();
  for (const e of i.taxonomy.entries) {
    if (e.sourceKind === 'COMPANY') detailFacts.set(e.sourceKey, text(e, company[e.sourceKey]));
    if (e.sourceKind === 'FACT') {
      const f = text(e, i.facts[e.sourceKey]);
      detailFacts.set(`fact:${e.sourceKey}`, f);
      if (!f && !e.mandatory) warnings.push(`The preparer's fact ${e.sourceKey} is not set: ${e.concept} is not tagged`);
    }
  }
  for (const e of i.taxonomy.entries.filter((x) => x.mandatory)) {
    const got = e.sourceKind === 'LINE' ? lineFacts.get(e.sourceKey)?.current : detailFacts.get(e.sourceKind === 'FACT' ? `fact:${e.sourceKey}` : e.sourceKey);
    if (!got) errors.push(`The mandatory ${e.sourceKind === 'LINE' ? 'line' : e.sourceKind === 'FACT' ? 'fact' : 'detail'} ${e.sourceKey} (${e.concept}) has no value`);
  }

  // contexts get their ids; duplicate facts of the same concept and context must agree
  const ctxIds = new Map([...ctxKeys.keys()].sort().map((k, n) => [k, `C${n + 1}`]));
  const seen = new Map<string, Fact>(), tagged = new Set<Fact>();
  for (const f of facts) {
    const k = `${f.entry.concept}|${f.ctx}`;
    const first = seen.get(k);
    if (!first) { seen.set(k, f); tagged.add(f); continue; }
    if (first.value !== f.value) errors.push(`${f.entry.concept} has two different values in the same context (${first.value} and ${f.value})`);
  }

  // rendering
  const unit = `U-${i.company.currency}`;
  const tag = (f: Fact | null | undefined, plain: string) => {
    if (!f || !tagged.has(f)) return esc(plain);
    const name = esc(f.entry.concept), ctx = ctxIds.get(f.ctx)!;
    if (f.entry.dataType === 'MONETARY') return `${f.negative ? '(' : ''}<ix:nonFraction name="${name}" contextRef="${ctx}" unitRef="${esc(unit)}" decimals="${f.entry.decimals}" scale="0" format="ixt:num-dot-decimal"${f.negative ? ' sign="-"' : ''}>${esc(f.display)}</ix:nonFraction>${f.negative ? ')' : ''}`;
    return `<ix:nonNumeric name="${name}" contextRef="${ctx}"${f.entry.dataType === 'DATE' ? ' format="ixt:date-year-month-day"' : ''}>${esc(f.display)}</ix:nonNumeric>`;
  };
  const shown = (l: Line, which: 'current' | 'prior') => {
    const v = which === 'current' ? l.amount : l.comparative;
    if (v === null || v === undefined) return '';
    const f = lineFacts.get(l.key)?.[which];
    return f ? tag(f, '') : esc(money(v).isNegative() ? `(${grouped(money(v).abs().toFixed(2))})` : grouped(money(v).toFixed(2)));
  };
  const statement = (title: string, lines: Line[]) => [
    `<h2>${esc(title)}</h2>`, '<table>',
    `<thead><tr><th>Line</th><th>${esc(i.year.end)}</th><th>${esc(i.year.priorEnd)}</th></tr></thead><tbody>`,
    ...lines.map((l) => `<tr><td>${esc(l.name)}</td><td class="num">${shown(l, 'current')}</td><td class="num">${shown(l, 'prior')}</td></tr>`),
    '</tbody></table>',
  ].join('\n');
  const hidden = [...detailFacts.entries()].filter(([k, f]) => f && (k.startsWith('fact:') || ['balanceSheetDate', 'directors'].includes(k))).map(([, f]) => tag(f, ''));
  const contexts = [...ctxKeys.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, c]) => [
    `<xbrli:context id="${ctxIds.get(k)}"><xbrli:entity><xbrli:identifier scheme="${esc(i.taxonomy.entityScheme ?? '')}">${esc(i.company.number ?? '')}</xbrli:identifier>`,
    c.dims.length ? `<xbrli:segment>${c.dims.map((d) => `<xbrldi:explicitMember dimension="${esc(d.axis)}">${esc(d.member)}</xbrldi:explicitMember>`).join('')}</xbrli:segment>` : '',
    '</xbrli:entity><xbrli:period>', c.period.instant ? `<xbrli:instant>${c.period.instant}</xbrli:instant>` : `<xbrli:startDate>${c.period.start}</xbrli:startDate><xbrli:endDate>${c.period.end}</xbrli:endDate>`,
    '</xbrli:period></xbrli:context>',
  ].join('')).join('\n');
  const sections = i.sections.flatMap((s) => s.items.map((it) => [`<h3>${esc(it.title)}</h3>`,
    ...it.blocks.map((b) => (b.type === 'text' ? b.text.split('\n').map((p) => `<p>${esc(p)}</p>`).join('\n') : `<p class="muted">[table ${esc(String((b as { key?: string }).key ?? ''))}]</p>`))].join('\n')));
  const xmlns = Object.entries({ ...SPEC_NAMESPACES, ...ns }).map(([p, u]) => ` xmlns:${p}="${esc(u)}"`).join('');
  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<html xmlns="http://www.w3.org/1999/xhtml"${xmlns}>`,
    `<head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/><title>${esc(i.company.name)} - accounts for the period ending ${esc(i.year.end)}</title>`,
    '<style>body{font-family:Arial,sans-serif;margin:32px;color:#172231}table{border-collapse:collapse;margin:8px 0 24px}td,th{padding:4px 12px;border-bottom:1px solid #e1e6ec;text-align:left}.num{text-align:right}.muted{color:#566170}</style></head>',
    '<body>',
    '<div style="display:none"><ix:header>',
    hidden.length ? `<ix:hidden>${hidden.join('')}</ix:hidden>` : '',
    `<ix:references><link:schemaRef xlink:type="simple" xlink:href="${esc(i.taxonomy.entryPoint)}"/></ix:references>`,
    `<ix:resources>\n${contexts}\n<xbrli:unit id="${esc(unit)}"><xbrli:measure>iso4217:${esc(i.company.currency)}</xbrli:measure></xbrli:unit>\n</ix:resources>`,
    '</ix:header></div>',
    `<h1>${tag(detailFacts.get('company.name'), i.company.name)}</h1>`,
    `<p>Registered number ${tag(detailFacts.get('company.number'), i.company.number ?? '')}</p>`,
    `<p>Accounts for the period ${tag(detailFacts.get('period.start'), i.year.start)} to ${tag(detailFacts.get('period.end'), i.year.end)}</p>`,
    statement('Profit and loss account', i.statements.profitAndLoss),
    statement('Balance sheet', i.statements.balanceSheet),
    sections.join('\n'),
    i.approval.director ? `<p>Approved by the board on ${tag(detailFacts.get('approval.date'), i.approval.approvedOn ?? '')} and signed on its behalf by ${tag(detailFacts.get('approval.director'), i.approval.director)}, Director.</p>` : '',
    '</body></html>', '',
  ].filter((x) => x !== '').join('\n');
  return { content, sha256: createHash('sha256').update(content).digest('hex'), factCount: tagged.size, contextCount: ctxKeys.size, errors, warnings };
}

export class IxbrlDocumentService {
  constructor(private readonly opts: { captureDeviceMetadata?: boolean } = {}) {}
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private view(d: Awaited<ReturnType<Tx['ixbrlDocument']['findUniqueOrThrow']>>, withContent = false) {
    return { id: d.id, companyId: d.companyId, packageId: d.packageId, taxonomyVersionId: d.taxonomyVersionId, status: d.status, sha256: d.sha256, factCount: d.factCount, contextCount: d.contextCount,
      errors: d.errors as string[], warnings: d.warnings as string[], byUserId: d.byUserId, at: d.at, ...(withContent ? { content: d.content } : {}),
      notice: 'Checked in the platform only: full schema and taxonomy validation with an external validator is a go-live step. Nothing is filed (DEC-082, DEC-086).' };
  }

  /** Builds and stores the document of the year's approved package (accounts:prepare). */
  async generate(tx: Tx, a: { organisationId: string; companyId: string; actor: { userId: string; kind?: string; can(p: string, companyId: string): boolean | Promise<boolean> }; yearStart: string; taxonomyVersionId?: string }) {
    if (a.actor.kind && a.actor.kind !== 'USER') throw forbidden('Only a person can generate a filing document', 'ai_cannot_write');
    if (!(await a.actor.can('accounts:prepare', a.companyId))) throw forbidden('Requires permission accounts:prepare', 'permission_denied');
    const fw = await tx.companyReportingFramework.findFirst({ where: { companyId: a.companyId, yearStart: new Date(`${a.yearStart}T00:00:00.000Z`) } });
    if (!fw) throw notFound(`No reporting framework is set for the year starting ${a.yearStart}`, 'framework_not_set');
    const pkg = await tx.accountsPackage.findFirst({ where: { frameworkId: fw.id } });
    if (!pkg) throw unprocessable('The year has no filing-ready package: the accounts must be approved and the package generated first', 'package_not_found');
    const c = pkg.content as Record<string, any>;
    const end = c.year.end as string;
    const versions = a.taxonomyVersionId
      ? await tx.xbrlTaxonomyVersion.findMany({ where: { id: a.taxonomyVersionId } })
      : await tx.xbrlTaxonomyVersion.findMany({ where: { standardCode: c.framework.standard.code, status: 'VERIFIED', effectiveFrom: { lte: new Date(`${end}T00:00:00.000Z`) },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date(`${end}T00:00:00.000Z`) } }] } });
    if (versions.length > 1) throw conflict(`More than one verified taxonomy version covers ${end} for ${c.framework.standard.code}; name the one to use`, 'taxonomy_ambiguous');
    const v = versions[0];
    if (!v || v.status !== 'VERIFIED' || v.standardCode !== c.framework.standard.code) {
      throw unprocessable(`No verified taxonomy version for ${c.framework.standard.code} covers the year end ${end}`, 'taxonomy_unverified');
    }
    if (!v.entityScheme) throw unprocessable('The taxonomy version has no entity identifier scheme; supersede it with one', 'entity_scheme_missing');
    const entries = (await tx.xbrlConceptMap.findMany({ where: { versionId: v.id }, orderBy: [{ sourceKind: 'asc' }, { sourceKey: 'asc' }] })).map(conceptEntryView);
    const priorFw = await tx.companyReportingFramework.findFirst({ where: { companyId: a.companyId, yearEnd: new Date(`${c.accounts.year.priorEnd}T00:00:00.000Z`) } });
    const facts: Record<string, string> = {};
    for (const f of await tx.accountsFact.findMany({ where: { frameworkId: fw.id }, orderBy: [{ setAt: 'asc' }, { id: 'asc' }] })) facts[f.key] = f.value;
    const r = buildIxbrl({
      taxonomy: { entryPoint: v.entryPoint, entityScheme: v.entityScheme, namespaces: v.namespaces as Record<string, string>, entries },
      company: { name: c.company.name, number: c.company.number ?? null, currency: c.company.currency },
      year: { start: c.year.start, end, priorStart: priorFw ? isoDay(priorFw.yearStart) : null, priorEnd: c.accounts.year.priorEnd },
      approval: { director: c.clientApproval?.director?.name ?? null, approvedOn: c.clientApproval?.approvedOn ?? null },
      statements: { profitAndLoss: c.accounts.statements.profitAndLoss, balanceSheet: c.accounts.statements.balanceSheet },
      balanced: c.accounts.reconciliation?.balanceSheet?.balanced === true, sections: c.accounts.sections ?? [], facts,
    });
    const d = await tx.ixbrlDocument.create({ data: { organisationId: a.organisationId, companyId: a.companyId, packageId: pkg.id, taxonomyVersionId: v.id, status: r.errors.length ? 'INVALID' : 'VALID',
      content: r.content, sha256: r.sha256, factCount: r.factCount, contextCount: r.contextCount, errors: r.errors, warnings: r.warnings, byUserId: a.actor.userId } });
    await this.audit(tx, { action: 'ixbrl.document_generated', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'ixbrl_document', entityId: d.id,
      after: { yearStart: a.yearStart, packageId: pkg.id, taxonomyVersionId: v.id, status: d.status, sha256: r.sha256, facts: r.factCount, errors: r.errors.length, warnings: r.warnings.length } });
    return this.view(d);
  }
  async list(tx: Tx, companyId: string, q: { yearStart?: string }) {
    let packageId: string | undefined;
    if (q.yearStart) {
      const fw = await tx.companyReportingFramework.findFirst({ where: { companyId, yearStart: new Date(`${q.yearStart}T00:00:00.000Z`) }, select: { id: true } });
      const pkg = fw ? await tx.accountsPackage.findFirst({ where: { frameworkId: fw.id }, select: { id: true } }) : null;
      if (!pkg) return { items: [] };
      packageId = pkg.id;
    }
    const rows = await tx.ixbrlDocument.findMany({ where: { companyId, ...(packageId ? { packageId } : {}) }, orderBy: { at: 'desc' } });
    return { items: rows.map((d) => this.view(d)) };
  }
  async get(tx: Tx, companyId: string, id: string, withContent = false) {
    const d = await tx.ixbrlDocument.findFirst({ where: { id, companyId } });
    if (!d) throw notFound('iXBRL document not found', 'ixbrl_document_not_found');
    return this.view(d, withContent);
  }
}
