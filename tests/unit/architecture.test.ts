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
const SRC = ['apps/api/src', 'apps/worker/src', 'packages/platform/src', 'packages/jobs/src', 'packages/contracts/src', 'packages/core/src', 'packages/db/src', 'packages/adapters/src'].flatMap((d) => files(join(ROOT, d)));
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
      'packages/platform/src/outbox.ts',                 // relay
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
    expect(imports.sort()).toEqual(['./outbox', './workflow', '@uk/contracts', '@uk/core', '@uk/db', 'zod'].sort());
  });
  it('integration adapters receive only SafeHttp, never raw fetch / network / database handles', () => {
    const src = read(join(ROOT, 'packages/platform/src/integrations.ts'));
    expect(src).toMatch(/interface IntegrationAdapter/);
    expect(src).toMatch(/execute\(operation: string, params: Record<string, unknown>, credentials: z\.output<S>, http: SafeHttp\)/);
  });
});
