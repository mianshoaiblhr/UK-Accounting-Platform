import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERMISSIONS, QUEUES, SYSTEM_ROLES } from '@uk/contracts';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, uploadDoc, waitForVersion, type Stack } from '../helpers/stack';

/**
 * V0 regression contract. Every later version (V1..V12) must keep this file green:
 * it pins the foundation behaviours other modules will depend on.
 */
let s: Stack;
beforeAll(async () => { s = await startStack(); });
afterAll(() => s.stop());

describe('regression: V0 foundation contract', () => {
  it('regression: practice onboarding journey end to end', async () => {
    const owner = await createUser(s, { type: 'PRACTICE', orgName: 'Journey LLP' });
    const client = await makeCompany(s, owner, 'Client One Ltd', 'JRNY0001');
    const period = await s.api().post(orgPath(owner, `/companies/${client.id}/periods`)).set(bearer(owner.token)).send({ startDate: '2025-04-01', endDate: '2026-03-31' });
    expect(period.status).toBe(201);
    const staff = await addMember(s, owner, 'bookkeeper', { scope: 'ASSIGNED', companyIds: [client.id] });
    const d = await uploadDoc(s, staff, { companyId: client.id });
    expect((await waitForVersion(s, owner, d.documentId, d.versionId)).status).toBe('AVAILABLE');
    const audit = await s.api().get(orgPath(owner, '/audit-events?limit=100')).set(bearer(owner.token));
    const actions = audit.body.items.map((e: { action: string }) => e.action);
    for (const a of ['organisation.created', 'company.created', 'period.created', 'invitation.created', 'invitation.accepted', 'document.created', 'document.available']) expect(actions).toContain(a);
  });

  it('regression: response contracts of core resources are stable', async () => {
    const u = await createUser(s, { type: 'BUSINESS' });
    const co = await makeCompany(s, u, 'Shape Ltd');
    expect(co).toMatchObject({ id: expect.any(String), organisationId: u.organisationId, name: 'Shape Ltd', status: 'ACTIVE', legalForm: 'LTD' });
    const me = await s.api().get('/api/v1/auth/me').set(bearer(u.token));
    expect(Object.keys(me.body).sort()).toEqual(['mfa', 'organisations', 'user']);
    expect(Object.keys(me.body.organisations[0]).sort()).toEqual(['id', 'membershipId', 'name', 'role', 'roleName', 'type']);
    const list = await s.api().get(orgPath(u, '/companies')).set(bearer(u.token));
    expect(Object.keys(list.body).sort()).toEqual(['items', 'nextCursor']);
  });

  it('regression: foundation inventory (roles, permissions, queues, tables) is append-only', () => {
    expect(SYSTEM_ROLES.map((r) => r.key)).toEqual(expect.arrayContaining(['owner', 'admin', 'accountant', 'bookkeeper', 'reviewer', 'client_viewer']));
    expect(PERMISSIONS.length).toBeGreaterThanOrEqual(18);
    expect(QUEUES).toEqual(expect.arrayContaining(['documents', 'imports', 'exports', 'ai', 'reconciliation', 'notifications', 'reports', 'integrations', 'scheduled']));
    const tables = adminSql(`SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`).split(',');
    for (const t of ['user', 'session', 'organisation', 'organisation_membership', 'practice', 'practice_membership', 'company_membership', 'role', 'company', 'accounting_period', 'document', 'document_version', 'audit_event', 'job_record']) expect(tables).toContain(t);
  });

  it('regression: version boundary — only the tables of versions that were approved exist (V0 + V1-M1 ledger core); nothing of invoicing, VAT, tax, payroll or filing', async () => {
    const tables = adminSql(`SELECT string_agg(table_name, ',') FROM information_schema.tables WHERE table_schema='public'`);
    // Allowed by decision: `tax_jurisdiction` is V0 master data; the V1-M1 ledger core adds account, journal, journal_line, ledger_sequence (DEC-001, v1-plan.md).
    // Each later V1 milestone widens this list in its own commit, with its acceptance package; anything else named like a future module still fails here.
    const unapproved = tables.replace(/tax_jurisdiction|ledger_sequence|journal_line|journal/g, '');
    expect(unapproved).not.toMatch(/ledger|invoice|vat|tax|payroll|hmrc|companies_house|ixbrl|posting/i);
    expect(tables).toContain('tax_jurisdiction');
    for (const t of ['account', 'journal', 'journal_line', 'ledger_sequence']) expect(tables.split(',')).toContain(t);
    const u = await createUser(s);
    for (const p of ['/invoices', '/vat', '/tax', '/filings']) {
      expect((await s.api().get(orgPath(u, p)).set(bearer(u.token))).status).toBe(404);
    }
  });

  it('regression: sessions, tenancy and audit survive an API restart (no in-memory state)', async () => {
    const u = await createUser(s);
    const second = await startStack(); // fresh app instance, same DB/Redis
    try {
      const me = await second.api().get('/api/v1/auth/me').set(bearer(u.token));
      expect(me.status).toBe(200);
      expect(me.body.organisations[0].id).toBe(u.organisationId);
    } finally { await second.stop(); }
  });
});
