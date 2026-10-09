import { ACCOUNT_SUBTYPES, DEBIT_NORMAL, DEFAULT_CHART, DEFAULT_CHART_VERSION, REPORT_LINES, REPORT_MAPPING_VERSION, type AccountType } from '@uk/contracts';
import { conflict, notFound, unprocessable } from '@uk/core';
import { Prisma, type Account, type Tx } from '@uk/db';
import { auditRow, changeSet } from '@uk/platform';

const isoDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const toDate = (s: string | null | undefined) => (s ? new Date(`${s}T00:00:00.000Z`) : null);
const AUDITED = ['name', 'subtype', 'taxTreatment', 'reportingMapping', 'activeFrom', 'activeTo'] as const;

export const accountView = (a: Account) => ({
  id: a.id, companyId: a.companyId, code: a.code, name: a.name, type: a.type, subtype: a.subtype, normalBalance: DEBIT_NORMAL.includes(a.type as AccountType) ? 'DEBIT' : 'CREDIT',
  isControl: a.isControl, controlKind: a.controlKind, taxTreatment: a.taxTreatment, reportingMapping: a.reportingMapping, reportingMappingVersion: REPORT_MAPPING_VERSION,
  activeFrom: isoDay(a.activeFrom), activeTo: isoDay(a.activeTo), isSystem: a.isSystem, createdAt: a.createdAt,
});

/** Chart of accounts (ADR-46). Accounts are deactivated, never deleted; identity fields freeze once an account has postings (database guard). */
export class AccountService {
  constructor(private readonly opts: { captureDeviceMetadata?: boolean } = {}) {}

  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }

  async create(tx: Tx, a: { organisationId: string; companyId: string; userId: string; input: { code: string; name: string; type: AccountType; subtype: string; isControl: boolean; controlKind: string | null; taxTreatment: string; reportingMapping: string; activeFrom: string | null; activeTo: string | null } }) {
    const i = a.input;
    try {
      const row = await tx.account.create({ data: { organisationId: a.organisationId, companyId: a.companyId, code: i.code, name: i.name, type: i.type, subtype: i.subtype, isControl: i.isControl, controlKind: i.controlKind,
        taxTreatment: i.taxTreatment, reportingMapping: i.reportingMapping, activeFrom: toDate(i.activeFrom), activeTo: toDate(i.activeTo) } });
      await this.audit(tx, { action: 'account.created', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.userId, entityType: 'account', entityId: row.id,
        after: { code: row.code, name: row.name, type: row.type, subtype: row.subtype, isControl: row.isControl, reportingMapping: row.reportingMapping } });
      return accountView(row);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict(`Account code ${i.code} already exists in this company`, 'account_code_exists');
      throw e;
    }
  }

  async list(tx: Tx, companyId: string, q: { active?: boolean; type?: AccountType } = {}) {
    const today = new Date(new Date().toISOString().slice(0, 10));
    const rows = await tx.account.findMany({ where: { companyId, ...(q.type ? { type: q.type } : {}),
      ...(q.active === true ? { AND: [{ OR: [{ activeFrom: null }, { activeFrom: { lte: today } }] }, { OR: [{ activeTo: null }, { activeTo: { gte: today } }] }] } : {}),
      ...(q.active === false ? { activeTo: { lt: today } } : {}) }, orderBy: { code: 'asc' } });
    return { items: rows.map(accountView) };
  }

  async get(tx: Tx, companyId: string, id: string) {
    const a = await tx.account.findFirst({ where: { id, companyId } });
    if (!a) throw notFound('Account not found');
    return accountView(a);
  }

  async update(tx: Tx, a: { organisationId: string; companyId: string; userId: string; id: string; input: { name?: string; subtype?: string; taxTreatment?: string; reportingMapping?: string; activeFrom?: string | null; activeTo?: string | null; reason?: string } }) {
    const before = await tx.account.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!before) throw notFound('Account not found');
    const i = a.input;
    const subtype = i.subtype ?? before.subtype, mapping = i.reportingMapping ?? before.reportingMapping;
    if (!ACCOUNT_SUBTYPES[before.type as AccountType].includes(subtype)) throw unprocessable('Subtype does not belong to the account type', 'invalid_subtype');
    if (!REPORT_LINES[mapping]?.types.includes(before.type as AccountType)) throw unprocessable('Reporting line does not accept this account type', 'invalid_reporting_mapping');
    if ((i.reportingMapping !== undefined || i.activeTo !== undefined || i.activeFrom !== undefined) && !i.reason?.trim()) throw unprocessable('A reason is required to change the reporting mapping or the active dates', 'reason_required');
    const data: Prisma.AccountUpdateInput = {
      ...(i.name !== undefined ? { name: i.name } : {}), ...(i.subtype !== undefined ? { subtype } : {}), ...(i.taxTreatment !== undefined ? { taxTreatment: i.taxTreatment } : {}),
      ...(i.reportingMapping !== undefined ? { reportingMapping: mapping } : {}),
      ...(i.activeFrom !== undefined ? { activeFrom: toDate(i.activeFrom) } : {}), ...(i.activeTo !== undefined ? { activeTo: toDate(i.activeTo) } : {}),
    };
    try {
      const after = await tx.account.update({ where: { id: before.id }, data });
      await this.audit(tx, { action: 'account.updated', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.userId, entityType: 'account', entityId: after.id, reason: i.reason,
        ...changeSet(before, after, AUDITED) });
      return accountView(after);
    } catch (e) {
      const msg = String((e as Error).message);
      if (msg.includes('cannot be deactivated') || msg.includes('cannot start after') || msg.includes('cannot change once')) throw unprocessable(msg.split('ERROR:').pop()!.trim().split('\n')[0]!, 'account_in_use');
      if (msg.includes('account_system_active_ck')) throw unprocessable('A system account cannot be deactivated', 'system_account');
      if (msg.includes('account_active_ck')) throw unprocessable('activeTo must not be before activeFrom', 'invalid_dates');
      throw e;
    }
  }

  /** Creates the default UK chart (template version recorded) in an EMPTY chart; never merges into an existing one. */
  async initialiseDefault(tx: Tx, a: { organisationId: string; companyId: string; userId: string }) {
    if ((await tx.account.count({ where: { companyId: a.companyId } })) > 0) throw conflict('This company already has a chart of accounts', 'chart_not_empty');
    await tx.account.createMany({ data: DEFAULT_CHART.map((t) => ({
      organisationId: a.organisationId, companyId: a.companyId, code: t.code, name: t.name, type: t.type, subtype: t.subtype, isControl: !!t.control, controlKind: t.control ?? null,
      taxTreatment: t.tax ?? 'NOT_APPLICABLE', reportingMapping: t.mapping, isSystem: !!t.system })) });
    await this.audit(tx, { action: 'account.chart_initialised', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.userId, entityType: 'company', entityId: a.companyId,
      metadata: { template: 'UK_SMALL_COMPANY', templateVersion: DEFAULT_CHART_VERSION, accounts: DEFAULT_CHART.length, reportMappingVersion: REPORT_MAPPING_VERSION } });
    return this.list(tx, a.companyId);
  }
}
