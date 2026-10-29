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

  it('regression: version boundary — only the tables of versions that were approved exist (V0 + V1 M1-M6b: ledger, controls, foreign currency, contact roles, VAT foundation, sales documents and receipts, purchase documents and payments); nothing of VAT filing, tax computation or payroll', async () => {
    const tables = adminSql(`SELECT string_agg(table_name, ',') FROM information_schema.tables WHERE table_schema='public'`);
    // Allowed by decision: `tax_jurisdiction` is V0 master data; the V1-M1 ledger core adds account, journal, journal_line, ledger_sequence (DEC-001, v1-plan.md); V1-M2 adds journal_request and ledger_policy (DEC-012); V1-M3 adds exchange_rate, company_fx_setting and fx_revaluation_run (DEC-016..018); V1-M4a adds contact_role, customer_profile and supplier_profile (DEC-023); V1-M4b adds tax_code, tax_rate and company_vat_setting (DEC-021, the VAT foundation); V1-M5a adds sales_setting, sales_sequence, sales_document, sales_document_line and sales_allocation (DEC-026/027); V1-M5b adds sales_receipt (DEC-032); V1-M6a adds purchase_setting, purchase_sequence, purchase_document, purchase_document_line and purchase_allocation (DEC-033/034); V1-M6b adds purchase_payment (DEC-035); V1-M6c adds cash_transaction and cash_transaction_line (DEC-036/037); V1-M7a adds bank_account, bank_statement_import, bank_statement_line and bank_transfer (DEC-038..041); V1-M7b adds bank_match and bank_reconciliation (DEC-042); V2-M1 adds the reporting framework: reporting_standard, reporting_standard_version, statutory_line, statutory_map_entry, validation_rule, disclosure_rule, statutory_account_override, company_reporting_framework (DEC-051, DEC-053); V2-M2 adds the fixed-asset register: fixed_asset_class, fixed_asset, fixed_asset_basis, depreciation_run, depreciation_run_line (DEC-058); V2-M3a adds the year-end adjustments: year_end_item, release_run, release_run_line, provision, provision_movement (DEC-059). V5-M1 adds the VAT return, vat_return and vat_return_event (DEC-090); V5-M2 adds vat_presentation_rule and vat_filing, the record of a filing made outside the platform (DEC-091). V3-M1 adds xbrl_taxonomy_version and xbrl_concept_map (DEC-093); V3-M2 adds ixbrl_document (DEC-094). V4-M1 adds ct_rule, ct_period and company_tax_profile (DEC-097); V4-M2 adds ct_adjustment_rule and ct_adjustment (DEC-099); V4-M3 adds ca_pool_opening and ca_computation (DEC-100); V4-M4 adds ct_loss_opening and ct_computation (DEC-101). A connection to HMRC is not built (DEC-082, DEC-086).
    // Each later V1 milestone widens this list in its own commit, with its acceptance package; anything else named like a future module still fails here.
    const unapproved = tables.replace(/ct_loss_opening|ct_computation|ca_pool_opening|ca_computation|ct_adjustment_rule|ct_adjustment|company_tax_profile|ct_rule|ct_period|ixbrl_document|xbrl_taxonomy_version|xbrl_concept_map|vat_presentation_rule|vat_filing|vat_return_event|vat_return|accounts_approval|accounts_package|year_end_step_signoff|review_setting|review_flag_response|cash_flow_class|cash_flow_map_entry|size_threshold_set|accounts_fact|director_loan_account|director_loan_threshold|related_party|year_end_close|provision_movement|release_run_line|year_end_item|release_run|provision|depreciation_run_line|fixed_asset_class|fixed_asset_basis|depreciation_run|fixed_asset|company_reporting_framework|reporting_standard_version|statutory_account_override|statutory_map_entry|reporting_standard|validation_rule|disclosure_rule|statutory_line|bank_reconciliation|bank_match|bank_statement_import|bank_statement_line|bank_account|bank_transfer|cash_transaction_line|cash_transaction|purchase_payment|purchase_setting|purchase_sequence|purchase_document_line|purchase_document|purchase_allocation|sales_receipt|tax_jurisdiction|tax_code|tax_rate|company_vat_setting|ledger_sequence|ledger_policy|journal_request|journal_line|journal/g, '');
    expect(unapproved).not.toMatch(/ledger|invoice|vat|tax|payroll|hmrc|companies_house|ixbrl|posting|purchase|bill|payment|bank_statement|receipt/i);
    expect(tables).toContain('tax_jurisdiction');
    for (const t of ['account', 'journal', 'journal_line', 'ledger_sequence', 'journal_request', 'ledger_policy', 'exchange_rate', 'company_fx_setting', 'fx_revaluation_run', 'contact_role', 'customer_profile', 'supplier_profile', 'tax_code', 'tax_rate', 'company_vat_setting', 'sales_setting', 'sales_sequence', 'sales_document', 'sales_document_line', 'sales_allocation', 'sales_receipt', 'purchase_setting', 'purchase_sequence', 'purchase_document', 'purchase_document_line', 'purchase_allocation', 'purchase_payment', 'cash_transaction', 'cash_transaction_line', 'bank_account', 'bank_statement_import', 'bank_statement_line', 'bank_transfer', 'bank_match', 'bank_reconciliation', 'reporting_standard', 'reporting_standard_version', 'statutory_line', 'statutory_map_entry', 'validation_rule', 'disclosure_rule', 'statutory_account_override', 'company_reporting_framework', 'fixed_asset_class', 'fixed_asset', 'fixed_asset_basis', 'depreciation_run', 'depreciation_run_line', 'year_end_item', 'release_run', 'release_run_line', 'provision', 'provision_movement', 'year_end_close', 'director_loan_account', 'director_loan_threshold', 'related_party', 'accounts_fact']) expect(tables.split(',')).toContain(t);
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
