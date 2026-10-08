import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildOpenApi } from '../../apps/api/src/openapi/build';
import { ORIGIN, bearer, createUser, orgPath, startStack, type Stack } from '../helpers/stack';

let s: Stack;
beforeAll(async () => { s = await startStack(); });
afterAll(() => s.stop());

const FILE = resolve(__dirname, '../../docs/api/openapi.json');
type Op = Record<string, any>;
const ops = (doc: any) => Object.entries(doc.paths).flatMap(([path, item]) =>
  Object.entries(item as Record<string, Op>).filter(([m]) => ['get', 'post', 'put', 'patch', 'delete'].includes(m)).map(([method, op]) => ({ path, method, op })));

describe('OpenAPI contract', () => {
  it('generates a valid OpenAPI 3 document (full schema validation, all $refs resolve)', async () => {
    const doc = JSON.parse(JSON.stringify(buildOpenApi(s.app)));
    const api = await SwaggerParser.validate(doc as never);
    expect((api as { openapi: string }).openapi).toMatch(/^3\./);
  });

  it('is versioned: every path lives under /api/v1 and the spec declares the API version', () => {
    const doc = buildOpenApi(s.app);
    expect(Object.keys(doc.paths).every((p) => p.startsWith('/api/v1/'))).toBe(true);
    expect(doc.info.version).toBe('1.0.0');
  });

  it('documents authentication: bearer + cookie schemes; only explicitly public routes opt out', () => {
    const doc = buildOpenApi(s.app);
    expect(doc.components!.securitySchemes).toMatchObject({ bearer: { type: 'http', scheme: 'bearer' }, cookie: { type: 'apiKey', in: 'cookie', name: 'uk_session' } });
    const publicOps = ops(doc).filter((o) => o.op.security?.length === 0).map((o) => `${o.method.toUpperCase()} ${o.path.replace('/api/v1', '')}`).sort();
    expect(publicOps).toEqual([
      'GET /healthz', 'GET /readyz', 'POST /auth/forgot-password', 'POST /auth/login', 'POST /auth/login/bearer', 'POST /auth/login/mfa', 'POST /auth/login/mfa/bearer',
      'POST /auth/register', 'POST /auth/resend-verification', 'POST /auth/reset-password', 'POST /auth/verify-email',
    ]);
  });

  it('every operation is fully documented: tag, summary, operationId, success + error responses', () => {
    const doc = buildOpenApi(s.app);
    const ids = new Set<string>();
    for (const { path, method, op } of ops(doc)) {
      const where = `${method.toUpperCase()} ${path}`;
      expect(op.tags?.length, `${where} tags`).toBe(1);
      expect(op.summary, `${where} summary`).toBeTruthy();
      expect(op.operationId, `${where} operationId`).toBeTruthy();
      expect(ids.has(op.operationId), `${where} duplicate operationId`).toBe(false);
      ids.add(op.operationId);
      const codes = Object.keys(op.responses);
      expect(codes.some((c) => /^2/.test(c)), `${where} success response`).toBe(true);
      expect(codes, `${where} 400`).toContain('400');
      if (op.security.length) expect(codes, `${where} 401`).toContain('401');
    }
  });

  it('documents error responses as RFC 9457 problem+json', () => {
    const doc = buildOpenApi(s.app) as any;
    for (const code of ['400', '401', '403', '404', '409', '422', '429']) {
      expect(doc.components.responses[code].content['application/problem+json'].schema.$ref).toBe('#/components/schemas/Problem');
    }
    expect(doc.components.schemas.Problem.required).toEqual(expect.arrayContaining(['title', 'status', 'code']));
  });

  it('request schemas ARE the runtime validators: bodies reference generated schemas, unknown fields forbidden', () => {
    const doc = buildOpenApi(s.app) as any;
    const create = doc.paths['/api/v1/organisations/{organisationId}/companies'].post;
    expect(create.requestBody.content['application/json'].schema.$ref).toBe('#/components/schemas/CreateCompanyRequest');
    const schema = doc.components.schemas.CreateCompanyRequest;
    expect(schema.required).toContain('name');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.companyNumber.pattern).toBeTruthy();
    expect(doc.components.schemas.RegisterRequest.properties.password.minLength).toBe(12);
  });

  it('documents permissions per operation and idempotency header', () => {
    const doc = buildOpenApi(s.app) as any;
    const op = doc.paths['/api/v1/organisations/{organisationId}/companies'].post;
    expect(op['x-required-permissions']).toEqual(['company:create']);
    expect(op.description).toContain('`company:create`');
    expect(op.parameters.map((p: { name: string }) => p.name)).toContain('Idempotency-Key');
    expect(op.responses).toHaveProperty('403');
  });

  it('documents pagination and filters as query parameters', () => {
    const doc = buildOpenApi(s.app) as any;
    const q = doc.paths['/api/v1/organisations/{organisationId}/tasks'].get.parameters.filter((p: { in: string }) => p.in === 'query').map((p: { name: string }) => p.name);
    expect(q).toEqual(expect.arrayContaining(['limit', 'cursor', 'status', 'assignee']));
  });

  it('the committed contract docs/api/openapi.json is up to date (regenerate with: pnpm openapi)', () => {
    const generated = JSON.stringify(buildOpenApi(s.app), null, 2) + '\n';
    if (process.env.UPDATE_OPENAPI === '1') { mkdirSync(resolve(FILE, '..'), { recursive: true }); writeFileSync(FILE, generated); }
    expect(readFileSync(FILE, 'utf8'), 'docs/api/openapi.json is stale — run `pnpm openapi` and commit').toBe(generated);
  });

  it('real responses conform to the documented shapes (spot checks against live endpoints)', async () => {
    const u = await createUser(s);
    const doc = buildOpenApi(s.app) as any;
    const co = await s.api().post(orgPath(u, '/companies')).set(bearer(u.token)).send({ name: 'Contract Ltd' });
    const required: string[] = doc.components.schemas.Company.required;
    for (const k of required) expect(co.body, `Company.${k}`).toHaveProperty(k);
    const me = await s.api().get('/api/v1/auth/me').set(bearer(u.token));
    for (const k of doc.components.schemas.Me.required) expect(me.body).toHaveProperty(k);
    const err = await s.api().post(orgPath(u, '/companies')).set(bearer(u.token)).send({ name: '' });
    for (const k of doc.components.schemas.Problem.required) expect(err.body).toHaveProperty(k);
  });
});

describe('development API documentation', () => {
  it('serves Swagger UI and the JSON contract outside production, with a docs-only CSP', async () => {
    const ui = await s.api().get('/api/docs');
    expect([200, 301]).toContain(ui.status);
    const json = await s.api().get('/api/docs/openapi.json');
    expect(json.status).toBe(200);
    expect(json.body.openapi).toMatch(/^3\./);
    expect(json.body.paths).toHaveProperty('/api/v1/auth/login');
    const html = await s.api().get('/api/docs/');
    expect(html.headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline'");
    const api = await s.api().get('/api/v1/healthz');
    expect(api.headers['content-security-policy']).toContain("default-src 'none'"); // the API itself stays strict
    void ORIGIN;
  });
  it('is disabled by default in production', async () => {
    const { loadConfig } = await import('@uk/core');
    const base = { DATABASE_URL: 'x', FIELD_ENCRYPTION_KEY: 'k', NODE_ENV: 'production', AWS_REGION: 'eu-west-2', STORAGE_DRIVER: 's3', S3_BUCKET: 'b', EMAIL_DRIVER: 'ses', AV_DRIVER: 'clamav' };
    expect(loadConfig(base).apiDocsEnabled).toBe(false);
    expect(loadConfig({ ...base, API_DOCS_ENABLED: 'true' }).apiDocsEnabled).toBe(true);
  });
});
