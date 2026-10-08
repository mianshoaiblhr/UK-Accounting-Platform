import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';
import { NAMED_RESPONSES, ROUTES } from './routes';

export const API_VERSION = '1';
const toSchema = (z: ZodTypeAny) => {
  const { $schema: _s, ...rest } = zodToJsonSchema(z as never, { target: 'openApi3', $refStrategy: 'none' }) as Record<string, unknown>;
  return rest;
};
const ref = (n: string) => ({ $ref: `#/components/schemas/${n}` });
const ERRORS: Record<number, string> = {
  400: 'Malformed request', 401: 'Not authenticated or session expired', 403: 'Authenticated but not permitted (RBAC, segregation of duties, CSRF origin)',
  404: 'Not found — also returned for resources in other organisations (existence is never revealed)', 409: 'Conflict with current state',
  413: 'Payload too large', 422: 'Validation failed (`errors[]` lists fields)', 429: 'Throttled (see `Retry-After`)', 503: 'Dependency unavailable',
};

/** Build the complete OpenAPI 3 contract for the running application. Throws if any route lacks documentation. */
export function buildOpenApi(app: INestApplication): OpenAPIObject {
  const base = new DocumentBuilder()
    .setTitle('UK Accounting Platform API')
    .setDescription('Practice-first accounting, tax and compliance platform. **V0 foundation:** identity, tenancy, RBAC, documents, jobs, audit, outbox events, workflows, tasks, notifications, integration and AI abstractions.\n\nAll tenant data lives under `/organisations/{organisationId}` and is protected by authentication, RBAC, company scope and PostgreSQL row-level security. Errors use RFC 9457 `application/problem+json`.')
    .setVersion(`${API_VERSION}.0.0`)
    .addServer('/', 'Same origin')
    .addBearerAuth({ type: 'http', scheme: 'bearer', description: 'Opaque session token from `POST /auth/login/bearer`' }, 'bearer')
    .addApiKey({ type: 'apiKey', in: 'cookie', name: 'uk_session', description: 'httpOnly SameSite=Strict cookie set by `POST /auth/login`. Unsafe methods must send an allowed `Origin`.' }, 'cookie')
    .build();
  const doc = SwaggerModule.createDocument(app, base, { operationIdFactory: (c, m) => `${c.replace(/Controller$/, '')}_${m}` });
  doc.security = [{ bearer: [] }, { cookie: [] }];
  doc.tags = [...new Set(Object.values(ROUTES).map((r) => r.tag))].map((name) => ({ name }));
  (doc.info as unknown as Record<string, unknown>)['x-api-versioning'] = 'URI versioning (/api/v1). Additive changes only within a version; breaking changes ship as /api/v2.';

  const schemas: Record<string, unknown> = {
    Problem: { type: 'object', required: ['type', 'title', 'status', 'code'], properties: {
      type: { type: 'string', example: 'urn:uk-platform:error:validation_error' }, title: { type: 'string' }, status: { type: 'integer' }, code: { type: 'string', description: 'Stable machine-readable error code' },
      errors: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, message: { type: 'string' } } } }, instance: { type: 'string' }, correlationId: { type: 'string', description: 'Echoes `x-request-id`' } } },
  };
  for (const [n, z] of Object.entries(NAMED_RESPONSES)) schemas[n] = toSchema(z);
  const errorResponses: Record<string, unknown> = {};
  for (const [code, description] of Object.entries(ERRORS)) errorResponses[code] = { description, content: { 'application/problem+json': { schema: ref('Problem') } } };
  doc.components = { ...doc.components, schemas: { ...(doc.components?.schemas ?? {}), ...schemas } as never, responses: errorResponses as never };

  const seen = new Set<string>();
  for (const [rawPath, item] of Object.entries(doc.paths)) {
    const path = rawPath.replace(/^\/api\/v1/, '');
    for (const [method, op] of Object.entries(item) as [string, Record<string, any>][]) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      const key = `${method.toUpperCase()} ${path}`;
      const d = ROUTES[key];
      if (!d) throw new Error(`OpenAPI: route ${key} has no entry in openapi/routes.ts`);
      seen.add(key);
      op.tags = [d.tag];
      op.summary = d.summary;
      if (d.description) op.description = d.description;
      const isPublic = op['x-public'] === true;
      const perms: string[] | undefined = op['x-required-permissions'];
      if (perms?.length) op.description = `${op.description ? op.description + '\n\n' : ''}**Requires permission:** ${perms.map((p) => `\`${p}\``).join(', ')}`;
      op.security = isPublic ? [] : [{ bearer: [] }, { cookie: [] }];
      op.parameters = (op.parameters ?? []).map((p: Record<string, any>) => p.in === 'path' ? { ...p, required: true, schema: { type: 'string', ...(p.name.endsWith('Id') ? { format: 'uuid' } : {}) } } : p);
      if (d.query) {
        const js = toSchema(d.query) as { properties?: Record<string, any>; required?: string[] };
        for (const [name, schema] of Object.entries(js.properties ?? {})) op.parameters.push({ name, in: 'query', required: js.required?.includes(name) ?? false, schema });
      }
      if (d.body) op.requestBody = { required: true, content: { 'application/json': { schema: ref(d.body[0]) } } };
      if (d.binaryBody) op.requestBody = { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } };
      if (d.body) schemas[d.body[0]] = toSchema(d.body[1]);
      const [status, schemaName, desc] = d.ok;
      op.responses = {
        [status]: schemaName
          ? { description: desc, content: { 'application/json': { schema: ref(schemaName) } } }
          : d.binaryResponse ? { description: desc, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } : { description: desc },
      };
      const errs = new Set<number>([400, ...(d.body || d.query ? [422] : []), ...(d.extraErrors ?? [])]);
      if (!isPublic) errs.add(401);
      if (perms) { errs.add(403); errs.add(404); }
      if (isPublic && key.startsWith('POST /auth/')) errs.add(429);
      for (const code of [...errs].sort()) op.responses[code] = { $ref: `#/components/responses/${code}` };
    }
  }
  for (const key of Object.keys(ROUTES)) if (!seen.has(key)) throw new Error(`OpenAPI: documented route ${key} does not exist`);
  doc.components!.schemas = { ...doc.components!.schemas, ...schemas } as never;
  return doc;
}

/** Mounts Swagger UI + the JSON contract (development / staging; disabled in production unless API_DOCS_ENABLED=true). */
export function mountApiDocs(app: INestApplication): void {
  SwaggerModule.setup('api/docs', app, buildOpenApi(app), {
    jsonDocumentUrl: 'api/docs/openapi.json', customSiteTitle: 'UK Accounting Platform API',
    swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha' },
  });
}
