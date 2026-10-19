import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TENANT_TABLES } from '../../packages/db/src/classification';

/** Static architecture rules. They fail the build when a boundary is crossed. */
const ROOT = resolve(__dirname, '../..');
function files(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (['node_modules', 'dist', '.next', 'generated'].includes(f)) continue;
    if (statSync(p).isDirectory()) files(p, out); else if (/\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f)) out.push(p);
  }
  return out;
}
const SRC = ['apps/api/src', 'apps/worker/src', 'packages/platform/src', 'packages/accounting/src', 'packages/jobs/src', 'packages/contracts/src', 'packages/core/src', 'packages/db/src', 'packages/adapters/src'].flatMap((d) => files(join(ROOT, d)));
const rel = (f: string) => relative(ROOT, f);
const read = (f: string) => readFileSync(f, 'utf8');
const camel = (t: string) => t.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

describe('authorisation is central, not re-implemented per controller (D6)', () => {
  const CENTRAL = ['apps/api/src/common/access.ts', 'apps/api/src/common/org.guard.ts', 'apps/api/src/common/types.ts', 'packages/contracts/src/authz.ts', 'packages/contracts/src/permissions.ts'];
  it('company/practice-level decisions never read raw role or scope data outside the central authoriser', () => {
    const offenders: string[] = [];
    const RAW = /org\.permissions\b|assignedCompanyIds|\bcompanyScope\s*===|canAccessCompany|\.orgRole\b|\.companyGrants\b|\.practiceGrants\b|\.reach\b/;
    for (const f of SRC.filter((x) => x.includes('apps/api/src') && !CENTRAL.includes(rel(x)))) {
      // the organisation service legitimately reads the CALLER's organisation role for role administration (ORG scope) - listed explicitly
      if (rel(f) === 'apps/api/src/organisations/organisations.service.ts' || rel(f) === 'apps/api/src/organisations/organisations.controller.ts') continue;
      if (RAW.test(read(f))) offenders.push(rel(f));
    }
    expect(offenders, 'ask org.access (AccessContext) instead of inspecting roles/scopes yourself').toEqual([]);
  });
  it('no service carries its own copy of the "visible companies" filter', () => {
    const offenders = SRC.filter((f) => /apps\/api\/src/.test(f) && /companyId: \{ in: \[\.\.\./.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });
  it('the pure authorisation module has no I/O dependencies', () => {
    const src = read(join(ROOT, 'packages/contracts/src/authz.ts'));
    expect([...src.matchAll(/from '([^']+)'/g)].map((m) => m[1])).toEqual(['./permissions']);
  });
});

describe('tenant isolation is structural, not conventional', () => {
  it('no code reads or writes tenant tables through the raw (context-free) Prisma client', () => {
    const models = new Set(TENANT_TABLES.map(camel));
    const offenders: string[] = [];
    for (const f of SRC) {
      if (rel(f).startsWith('packages/db/')) continue;
      for (const m of read(f).matchAll(/\.prisma\.(\w+)\./g)) if (models.has(m[1]!)) offenders.push(`${rel(f)}: prisma.${m[1]}`);
    }
    expect(offenders, 'use db.tenant()/asUser()/system() so row-level security gets a context').toEqual([]);
  });

  it('the trusted cross-tenant system context is used only by reviewed infrastructure files', () => {
    const users = SRC.filter((f) => /\.system\(/.test(read(f))).map(rel).sort();
    expect(users).toEqual([
      'apps/api/src/audit/audit.service.ts',            // pre-tenant audit events with no actor
      'apps/api/src/organisations/organisations.service.ts', // invitation lookup by secret token, then re-enters tenant context
      'packages/jobs/src/producer.ts',                   // org-less system jobs + sweeper
      'packages/jobs/src/runtime.ts',                    // org-less job bookkeeping
      'packages/platform/src/event-bus.ts',              // event load + org-less consumers
      'packages/platform/src/metrics.ts',                // read-only cross-tenant aggregates (counts only) for metrics/readiness
      'packages/platform/src/notification-delivery.ts',  // lists due planned deliveries (read-only); every write runs in the owning tenant's context
      'packages/platform/src/outbox.ts',                 // relay
      'packages/platform/src/task-reminders.ts',         // lists due reminders (read-only); every write runs in the owning tenant's context
      'packages/platform/src/workflow-overdue.ts',       // lists overdue workflow instances (read-only); every write runs in the owning tenant's context
    ]);
  });

  it('only the db package imports @prisma/client', () => {
    const offenders = SRC.filter((f) => !rel(f).startsWith('packages/db/') && /from '@prisma\/client'/.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('every API controller route that touches tenant data sits behind @RequirePermissions (global org guard)', () => {
    const offenders: string[] = [];
    for (const f of SRC.filter((x) => /controller\.ts$/.test(x) && x.includes('apps/api'))) {
      const src = read(f);
      const isAuth = /auth\.controller|health\.controller|audit\.controller|organisations\.controller/.test(f);
      for (const m of src.matchAll(/@(Get|Post|Put|Patch|Delete)\(([^)]*)\)/g)) {
        const route = m[2]!;
        const tail = src.slice(m.index!, m.index! + 400);
        const decorators = tail.slice(0, tail.search(/\n\s*(async |[a-z]\w*\()/) > 0 ? tail.search(/\n\s*(async |[a-z]\w*\()/) : 400);
        if (/organisationId/.test(src.split('@Controller(')[1]!.split(')')[0]!) || /organisations\/:organisationId/.test(route)) {
          if (!decorators.includes('RequirePermissions')) offenders.push(`${rel(f)}: ${m[1]} ${route}`);
        }
      }
      void isAuth;
    }
    expect(offenders).toEqual([]);
  });
});

describe('adapter boundary: no S3 / ClamAV specifics outside packages/adapters', () => {
  const FORBIDDEN = /@aws-sdk|\bS3Client\b|\bPutObjectCommand\b|\bGetObjectCommand\b|\bclamd\b|\bINSTREAM\b|ClamAvScanner|\bS3Storage\b|\bLocalStorage\b/;
  const EXEMPT = new Set(['packages/core/src/config.ts']); // env var NAMES only (CLAMAV_HOST, S3_BUCKET)
  it('business, domain and platform code never import AWS / ClamAV code', () => {
    const offenders = SRC.filter((f) => !rel(f).startsWith('packages/adapters/') && !EXEMPT.has(rel(f)) && FORBIDDEN.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });
  it('application code imports only the PORTS from @uk/adapters (+ the factory functions)', () => {
    const allowed = new Set(['StoragePort', 'AntivirusPort', 'EmailPort', 'sniffMatches', 'createStorage', 'createAntivirus', 'createEmail', 'PresignedUpload', 'ScanResult', 'OutboundEmail']);
    const bad: string[] = [];
    for (const f of SRC.filter((x) => !rel(x).startsWith('packages/adapters/'))) {
      for (const m of read(f).matchAll(/import (?:type )?\{([^}]+)\} from '@uk\/adapters'/g)) {
        for (const name of m[1]!.split(',').map((s) => s.trim().replace(/^type /, '')).filter(Boolean)) if (!allowed.has(name)) bad.push(`${rel(f)}: ${name}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it('driver selection is confined to the factory functions in packages/adapters/src/index.ts', () => {
    const src = read(join(ROOT, 'packages/adapters/src/index.ts'));
    expect(src).toMatch(/export function createStorage/);
    expect(src).toMatch(/export function createAntivirus/);
  });
});

describe('AI boundary: AI code cannot reach ledger, filing or document writers', () => {
  it('the AI gateway module imports nothing that can write business data', () => {
    const src = read(join(ROOT, 'packages/platform/src/ai.ts'));
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    // './audit' only builds rows for the append-only audit trail (no business tables)
    expect(imports.sort()).toEqual(['./audit', './outbox', './workflow', '@uk/contracts', '@uk/core', '@uk/db', 'zod'].sort());
  });
  it('integration adapters receive only SafeHttp, never raw fetch / network / database handles', () => {
    const src = read(join(ROOT, 'packages/platform/src/integrations.ts'));
    expect(src).toMatch(/interface IntegrationAdapter/);
    expect(src).toMatch(/execute\(operation: string, params: Record<string, unknown>, credentials: z\.output<S>, http: SafeHttp\)/);
  });
});

describe('database access paths that carry security meaning', () => {
  it('only the task service writes tasks (the review rule has one application path, backed by the database trigger)', () => {
    const WRITE = /\.task\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|\b(INSERT INTO|UPDATE|DELETE FROM)\s+"?task"?\b/i;
    const writers = SRC.filter((f) => WRITE.test(read(f))).map(rel).sort();
    expect(writers).toEqual(['apps/api/src/tasks/tasks.service.ts']);
  });
  it('only the PostingService writes the ledger (V1 manifest control 1): journals, lines and the numbering counter', () => {
    const WRITE = /\.(journal|journalLine|ledgerSequence)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|\b(INSERT INTO|UPDATE|DELETE FROM)\s+"?(journal|journal_line|ledger_sequence)"?\b/i;
    expect(SRC.filter((f) => WRITE.test(read(f))).map(rel)).toEqual(['packages/accounting/src/posting.ts']);
  });
  it('only the request service writes journal requests and the ledger policy (M2): approval state has one writer', () => {
    const WRITE = /\.(journalRequest|ledgerPolicy)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|\b(INSERT INTO|UPDATE|DELETE FROM)\s+"?(journal_request|ledger_policy)"?\b/i;
    expect(SRC.filter((f) => WRITE.test(read(f))).map(rel)).toEqual(['packages/accounting/src/requests.ts']);
  });
  it('FX data has one writer each (M3): rates and settings only in fx.ts, revaluation runs only in revaluation.ts; nothing posts a journal from there', () => {
    const writes = (model: string) => new RegExp(`\\.${model}\\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\\b|\\b(INSERT INTO|UPDATE|DELETE FROM)\\s+"?${model.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}"?\\b`, 'i');
    expect(SRC.filter((f) => writes('exchangeRate').test(read(f))).map(rel)).toEqual(['packages/accounting/src/fx.ts']);
    expect(SRC.filter((f) => writes('companyFxSetting').test(read(f))).map(rel)).toEqual(['packages/accounting/src/fx.ts']);
    expect(SRC.filter((f) => writes('fxRevaluationRun').test(read(f))).map(rel)).toEqual(['packages/accounting/src/revaluation.ts']);
    expect(read(`${ROOT}/packages/accounting/src/fx.ts`)).not.toMatch(/\.journal(Line)?\.(create|createMany)/);
    expect(read(`${ROOT}/packages/accounting/src/revaluation.ts`)).not.toMatch(/\.journal(Line)?\.(create|createMany)/);
  });
  it('VAT rules have one writer (M4b) and never post: codes, rate versions and settings only in vat.ts', () => {
    const WRITE = /\.(taxCode|taxRate|companyVatSetting)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|\b(INSERT INTO|UPDATE|DELETE FROM)\s+"?(tax_code|tax_rate|company_vat_setting)"?\b/i;
    expect(SRC.filter((f) => WRITE.test(read(f))).map(rel)).toEqual(['packages/accounting/src/vat.ts']);
    expect(read(`${ROOT}/packages/accounting/src/vat.ts`)).not.toMatch(/\.journal(Line)?\.(create|createMany)/);
  });
  it('sales documents have one writer (M5a), which posts only through the PostingService', () => {
    const WRITE = /\.(salesSetting|salesSequence|salesDocument|salesDocumentLine|salesAllocation|salesReceipt)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|\b(INSERT INTO|UPDATE|DELETE FROM)\s+"?(sales_setting|sales_sequence|sales_document|sales_document_line|sales_allocation|sales_receipt)"?\b/i;
    expect(SRC.filter((f) => WRITE.test(read(f))).map(rel)).toEqual(['packages/accounting/src/sales.ts']);
    expect(read(`${ROOT}/packages/accounting/src/sales.ts`)).not.toMatch(/\.journal(Line)?\.(create|createMany)|INSERT INTO\s+"?journal/);
  });
  it('purchase documents have one writer (M6a), which posts only through the PostingService', () => {
    const WRITE = /\.(purchaseSetting|purchaseSequence|purchaseDocument|purchaseDocumentLine|purchaseAllocation|purchasePayment)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|\b(INSERT INTO|UPDATE|DELETE FROM)\s+"?(purchase_setting|purchase_sequence|purchase_document|purchase_document_line|purchase_allocation|purchase_payment)"?\b/i;
    expect(SRC.filter((f) => WRITE.test(read(f))).map(rel)).toEqual(['packages/accounting/src/purchases.ts']);
    expect(read(`${ROOT}/packages/accounting/src/purchases.ts`)).not.toMatch(/\.journal(Line)?\.(create|createMany)|INSERT INTO\s+"?journal/);
  });
  it('cash transactions have one writer (M6c), which posts only through the PostingService', () => {
    const WRITE = /\.(cashTransaction|cashTransactionLine)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|\b(INSERT INTO|UPDATE|DELETE FROM)\s+"?(cash_transaction|cash_transaction_line)"?\b/i;
    expect(SRC.filter((f) => WRITE.test(read(f))).map(rel)).toEqual(['packages/accounting/src/cash.ts']);
    expect(read(`${ROOT}/packages/accounting/src/cash.ts`)).not.toMatch(/\.journal(Line)?\.(create|createMany)|INSERT INTO\s+"?journal/);
  });
  it('bank accounts and transfers have one writer (M7a), the only code that sees bank-account details in clear, posting only through the PostingService', () => {
    const WRITE = /\.(bankAccount|bankTransfer)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|\b(INSERT INTO|UPDATE|DELETE FROM)\s+"?(bank_account|bank_transfer)"?\b/i;
    expect(SRC.filter((f) => WRITE.test(read(f))).map(rel)).toEqual(['packages/accounting/src/bank.ts']);
    expect(SRC.filter((f) => /accountDetailsEnc|account_details_enc/.test(read(f))).map(rel)).toEqual(['packages/accounting/src/bank.ts']);
    expect(read(`${ROOT}/packages/accounting/src/bank.ts`)).not.toMatch(/\.journal(Line)?\.(create|createMany)|INSERT INTO\s+"?journal/);
  });
  it('reconciliation has one writer (M7b), which posts only through CashService and the PostingService and never writes statement lines', () => {
    const WRITE = /\.(bankMatch|bankReconciliation)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|\b(INSERT INTO|UPDATE|DELETE FROM)\s+"?(bank_match|bank_reconciliation)"?\b/i;
    expect(SRC.filter((f) => WRITE.test(read(f))).map(rel)).toEqual(['packages/accounting/src/reconciliation.ts']);
    expect(read(`${ROOT}/packages/accounting/src/reconciliation.ts`)).not.toMatch(/\.journal(Line)?\.(create|createMany)|INSERT INTO\s+"?journal|\.bankStatementLine\.(update|create)|app\.bank_match/);
  });
  it('bank statements are staged by one writer in the platform package, which never posts (ADR-61)', () => {
    const WRITE = /\.(bankStatementImport|bankStatementLine)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|\b(INSERT INTO|UPDATE|DELETE FROM)\s+"?(bank_statement_import|bank_statement_line)"?\b/i;
    expect(SRC.filter((f) => WRITE.test(read(f))).map(rel)).toEqual(['packages/platform/src/bank-statements.ts']);
    expect(read(`${ROOT}/packages/platform/src/bank-statements.ts`)).not.toMatch(/PostingService|\.journal(Line)?\.(create|createMany)|app\.posting/);
  });
  it('financial statements read the ledger only, never a source-document table (V1-ARC-02, M8)', () => {
    const src = read(`${ROOT}/packages/accounting/src/reports.ts`);
    expect(src).not.toMatch(/\.(salesDocument|salesReceipt|salesAllocation|purchaseDocument|purchasePayment|purchaseAllocation|cashTransaction|bankTransfer|bankStatement\w*|bankMatch|journalRequest|contact\w*)\./);
    expect(src).not.toMatch(/\b(FROM|JOIN)\s+"?(sales_|purchase_|cash_|bank_|contact|journal_request)/i);
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
  });
  it('statutory statements read the ledger and the reporting framework only, and write nothing (V2-M1, ADR-63)', () => {
    const src = read(`${ROOT}/packages/accounting/src/statutory-report.ts`);
    const reads = [...src.matchAll(/\btx\.(\w+)\./g)].map((m) => m[1]);
    expect([...new Set(reads)].sort()).toEqual(['company', 'companyReportingFramework', 'currency', 'reportingStandard', 'reportingStandardVersion', 'statutoryAccountOverride', 'statutoryLine', 'statutoryMapEntry', 'validationRule']);
    expect([...src.matchAll(/\b(?:FROM|JOIN)\s+"?(\w+)/g)].map((m) => m[1]).sort()).toEqual(['account', 'journal', 'journal_line']);
    expect(src).not.toMatch(/\btx\.\w+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(|\$executeRaw|\b(INSERT|UPDATE|DELETE)\b/);
    expect(src).not.toMatch(/\beval\(|new Function\(/);
  });
  it('no transaction module reads the reporting framework: only the framework service and the statutory report service touch its tables (V2-ARC-01, ADR-62)', () => {
    const TOUCH = /\.(reportingStandard|reportingStandardVersion|statutoryLine|statutoryMapEntry|validationRule|disclosureRule|statutoryAccountOverride|companyReportingFramework)\.|\b(reporting_standard\w*|statutory_(line|map_entry|account_override)|validation_rule|disclosure_rule|company_reporting_framework)\b/;
    const users = SRC.filter((f) => !f.endsWith('.test.ts') && !rel(f).startsWith('packages/db/src/') && !rel(f).startsWith('packages/contracts/src/retention')).filter((f) => TOUCH.test(read(f))).map(rel).sort();
    expect(users).toEqual(['packages/accounting/src/statutory-report.ts', 'packages/accounting/src/statutory.ts']);
  });
  it('depreciation never reads the tax fields (V2-FA-07, DEC-058): the arithmetic, the shared asset state and the depreciation service do not mention them', () => {
    const math = read(`${ROOT}/packages/accounting/src/depreciation-math.ts`);
    const fa = read(`${ROOT}/packages/accounting/src/fixed-assets.ts`);
    const state = fa.slice(fa.indexOf('class AssetState'), fa.indexOf('export class FixedAssetService'));
    const dep = fa.slice(fa.indexOf('export class DepreciationService'));
    expect(state.length).toBeGreaterThan(200);
    expect(dep.length).toBeGreaterThan(1000);
    for (const src of [math, state, dep]) expect(src).not.toMatch(/tax(Category|Cost|_category|_cost)/);
  });
  it('the fixed-asset register has one writer, which alone posts the FIXED_ASSET_* sources, through the PostingService only (V2-M2)', () => {
    const WRITE = /\.(fixedAssetClass|fixedAsset|fixedAssetBasis|depreciationRun|depreciationRunLine)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|\b(INSERT INTO|UPDATE|DELETE FROM)\s+"?(fixed_asset\w*|depreciation_run\w*)"?\b/i;
    expect(SRC.filter((f) => WRITE.test(read(f))).map(rel)).toEqual(['packages/accounting/src/fixed-assets.ts']);
    expect(SRC.filter((f) => /sourceType: '(FIXED_ASSET_\w+)'/.test(read(f))).map(rel)).toEqual(['packages/accounting/src/fixed-assets.ts']);
    expect(read(`${ROOT}/packages/accounting/src/fixed-assets.ts`)).not.toMatch(/\.journal(Line)?\.(create|createMany|update)|INSERT INTO\s+"?journal/);
  });
  it('the year-end adjustments have one writer, which alone posts their sources, through the PostingService only (V2-M3a)', () => {
    const WRITE = /\.(yearEndItem|releaseRun|releaseRunLine|provision|provisionMovement)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|\b(INSERT INTO|UPDATE|DELETE FROM)\s+"?(year_end_item|release_run\w*|provision\w*)"?\b/i;
    expect(SRC.filter((f) => WRITE.test(read(f))).map(rel)).toEqual(['packages/accounting/src/year-end.ts']);
    expect(SRC.filter((f) => /source: '(ACCRUAL|ACCRUAL_AUTO_REVERSAL|ACCRUAL_CANCELLATION|ADJUSTMENT_\w+|PROVISION_\w+)'/.test(read(f))).map(rel)).toEqual(['packages/accounting/src/year-end.ts']);
    expect(read(`${ROOT}/packages/accounting/src/year-end.ts`)).not.toMatch(/\.journal(Line)?\.(create|createMany|update)|INSERT INTO\s+"?journal/);
  });
  it('the year-end close has one writer, which alone posts the closing sources, through the PostingService only; every statement leaves closing journals out (V2-M3b)', () => {
    const WRITE = /\.yearEndClose\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|\b(INSERT INTO|UPDATE|DELETE FROM)\s+"?year_end_close"?\b/i;
    expect(SRC.filter((f) => WRITE.test(read(f))).map(rel)).toEqual(['packages/accounting/src/year-end-close.ts']);
    expect(SRC.filter((f) => /sourceType: '(YEAR_END_CLOSE|YEAR_END_CLOSE_REVERSAL)'/.test(read(f))).map(rel)).toEqual(['packages/accounting/src/year-end-close.ts']);
    expect(read(`${ROOT}/packages/accounting/src/year-end-close.ts`)).not.toMatch(/\.journal(Line)?\.(create|createMany|update)|INSERT INTO\s+"?journal/);
    // the statements that sum income and expense name the closing sources, and the PostingService refuses a closed year (DEC-060)
    for (const f of ['reports.ts', 'statutory-report.ts', 'posting.ts', 'ledger.ts']) expect(read(`${ROOT}/packages/accounting/src/${f}`), f).toMatch(/CLOSING_SOURCES/);
  });
  it('the reporting framework has one writer per side (V2-M1): standard content in StandardsService, company choices in FrameworkService, both in statutory.ts', () => {
    const WRITE = /\.(reportingStandard|reportingStandardVersion|statutoryLine|statutoryMapEntry|validationRule|disclosureRule|statutoryAccountOverride|companyReportingFramework)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|\b(INSERT INTO|UPDATE|DELETE FROM)\s+"?(reporting_standard\w*|statutory_\w+|validation_rule|disclosure_rule|company_reporting_framework)"?\b/i;
    expect(SRC.filter((f) => WRITE.test(read(f))).map(rel)).toEqual(['packages/accounting/src/statutory.ts']);
    expect(read(`${ROOT}/packages/accounting/src/statutory.ts`)).not.toMatch(/\.journal(Line)?\.|PostingService|\beval\(|new Function\(/);
  });
  it('customer and supplier roles have one writer (M4a), and only it touches supplier bank-detail ciphertext', () => {
    const WRITE = /\.(contactRole|customerProfile|supplierProfile)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|\b(INSERT INTO|UPDATE|DELETE FROM)\s+"?(contact_role|customer_profile|supplier_profile)"?\b/i;
    expect(SRC.filter((f) => WRITE.test(read(f))).map(rel)).toEqual(['apps/api/src/master-data/contact-roles.service.ts']);
    expect(SRC.filter((f) => /bankDetailsEnc|bank_details_enc/.test(read(f))).map(rel)).toEqual(['apps/api/src/master-data/contact-roles.service.ts']);
  });
  it('request-based journal sources are posted from a request only: the API source list never offers them', () => {
    const api = read(`${ROOT}/packages/contracts/src/ledger.ts`);
    expect(api).toMatch(/API_JOURNAL_SOURCES = \['MANUAL'\]/);
    expect(read(`${ROOT}/packages/contracts/src/ledger.ts`)).toMatch(/OPENING_BALANCE:[^\n]*requiresRequest: true/);
    expect(read(`${ROOT}/packages/contracts/src/ledger.ts`)).toMatch(/CONTROL_ADJUSTMENT:[^\n]*requiresRequest: true/);
  });
  it('the database posting switch is set by the PostingService and by nothing else', () => {
    expect(SRC.filter((f) => /app\.posting/.test(read(f))).map(rel)).toEqual(['packages/accounting/src/posting.ts']);
  });
  it('only the account service writes the chart of accounts', () => {
    const WRITE = /\.account\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|\b(INSERT INTO|UPDATE|DELETE FROM)\s+"?account"?\b/i;
    expect(SRC.filter((f) => WRITE.test(read(f))).map(rel)).toEqual(['packages/accounting/src/accounts.ts']);
  });
  it('AI code cannot reach the posting code: nothing in platform or the AI module imports @uk/accounting (manifest control 10)', () => {
    const offenders = SRC.filter((f) => (rel(f).startsWith('packages/platform/') || rel(f).startsWith('apps/api/src/ai/') || rel(f).startsWith('apps/worker/')) && /@uk\/accounting/.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });
  it('append-only tables are only ever inserted into by application code', () => {
    const APPEND_ONLY = ['auditEvent', 'workflowTransition', 'aiRun', 'taskComment', 'journal', 'journalLine'];
    const WRITE = new RegExp(`\\.(${APPEND_ONLY.join('|')})\\.(update|updateMany|upsert|delete|deleteMany)\\b`);
    expect(SRC.filter((f) => WRITE.test(read(f))).map(rel)).toEqual([]);
  });
  it('no raw SQL built from strings anywhere in the runtime code (Prisma tagged templates only)', () => {
    expect(SRC.filter((f) => /\$(queryRawUnsafe|executeRawUnsafe)\b/.test(read(f))).map(rel)).toEqual([]);
  });
  it('documents are read only where per-document visibility is applied (ADR-32)', () => {
    const READ = /\.document\.(findUnique|findUniqueOrThrow|findFirst|findMany)\b/;
    expect(SRC.filter((f) => READ.test(read(f))).map(rel).sort()).toEqual([
      'apps/api/src/documents/documents.service.ts', // getDocument()/list() apply visibility
      'apps/api/src/evidence/evidence.service.ts', // resolver applies canReadDocument
      'apps/api/src/tasks/tasks.service.ts',       // readableDocument()/listAttachments() apply canReadDocument
      'packages/accounting/src/requests.ts',       // request evidence check uses the requester's canReadDocument
      'packages/accounting/src/vat.ts',            // VAT-rule verification evidence uses the verifier's canReadDocument
      'packages/platform/src/workflow.ts',         // evidence check uses Actor.canReadDocument
    ]);
  });
});
