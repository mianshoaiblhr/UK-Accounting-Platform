#!/usr/bin/env node
/**
 * Imports a draft standard pack (content/standards/drafts/*.json, DEC-064) through the public API, as the person whose token is used (they need
 * accounts:rules-manage). The pack lands as an UNVERIFIED standard version: this tool never verifies anything. A holder of accounts:rule-verify
 * who is not the importer checks every rule and verifies it in the platform (DEC-052).
 *
 *   node scripts/standards/import-pack.mjs --api https://host/api/v1 --org <organisationId> --company <companyId> --token <bearer> <pack.json>
 */
import { readFileSync } from 'node:fs';

/** `call(method, path, body)` sends a request under /organisations/:org/companies/:company and resolves to { status, body }. */
export async function importPack(call, pack) {
  const must = async (what, method, path, body, expect = [200, 201]) => {
    const r = await call(method, path, body);
    if (!expect.includes(r.status)) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const standards = (await must('list standards', 'get', '/reporting-standards')).items;
  const standard = standards.find((s) => s.code === pack.standard.code) ?? (await must('create standard', 'post', '/reporting-standards', pack.standard));
  const version = await must('create version', 'post', `/reporting-standards/${standard.id}/versions`, pack.version);
  const v = `/reporting-standard-versions/${version.id}`;
  for (const l of pack.lines) await must(`line ${l.key}`, 'post', `${v}/lines`, l);
  for (const [sourceLine, accountSubtype, targetKey] of pack.mapEntries) await must(`map ${sourceLine}`, 'post', `${v}/map-entries`, { sourceLine, accountSubtype, targetKey });
  for (const r of pack.validationRules) await must(`validation rule ${r.key}`, 'post', `${v}/validation-rules`, r);
  // the provision reference and the note for the verifier stay in the pack and the review workbook; the platform stores the wording
  for (const { source: _source, verifierNote: _note, ...r } of pack.rules) await must(`wording ${r.key}`, 'post', `${v}/disclosure-rules`, r);
  const content = await must('read back', 'get', v);
  return { standardId: standard.id, versionId: version.id, status: content.status, lines: content.lines.length, mapEntries: content.mapEntries.length,
    validationRules: content.validationRules.length, disclosureRules: content.disclosureRules.length, problems: content.problems };
}

const args = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const [api, org, company, token] = ['api', 'org', 'company', 'token'].map(opt);
  const file = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')).pop();
  if (!api || !org || !company || !token || !file) { console.error('usage: import-pack.mjs --api <url> --org <id> --company <id> --token <bearer> <pack.json>'); process.exit(2); }
  const pack = JSON.parse(readFileSync(file, 'utf8'));
  const call = async (method, path, body) => {
    const r = await fetch(`${api}/organisations/${org}/companies/${company}${path}`, { method: method.toUpperCase(), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  importPack(call, pack).then((r) => { console.log(JSON.stringify(r, null, 2)); console.log('Imported as UNVERIFIED. Verification is for a holder of accounts:rule-verify who is not the importer (DEC-052).'); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
