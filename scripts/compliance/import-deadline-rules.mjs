#!/usr/bin/env node
/**
 * Imports the draft deadline rules (content/compliance/drafts/uk-deadline-rules.json, DEC-088) through the public API, as the person whose token is used (they need
 * compliance:rules-manage). Each rule lands as an UNVERIFIED version: this tool never verifies anything. A holder of compliance:rule-verify who is not the importer checks
 * each rule against its provision and verifies it in the platform.
 *
 *   node scripts/compliance/import-deadline-rules.mjs --api https://host/api/v1 --org <organisationId> --token <bearer> <pack.json>
 */
import { readFileSync } from 'node:fs';

/** `call(method, path, body)` sends a request under /organisations/:org and resolves to { status, body }. */
export async function importDeadlineRules(call, pack) {
  const out = [];
  for (const { verifierNote: _note, ...rule } of pack.rules) {
    const r = await call('post', '/compliance/deadline-rules', rule);
    if (r.status !== 201) throw new Error(`deadline rule ${rule.kind}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
    out.push({ id: r.body.id, kind: r.body.kind, legalForms: r.body.legalForms, verificationStatus: r.body.verificationStatus });
  }
  return { rules: out };
}

const args = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const [api, org, token] = ['api', 'org', 'token'].map(opt);
  const file = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')).pop();
  if (!api || !org || !token || !file) { console.error('usage: import-deadline-rules.mjs --api <url> --org <id> --token <bearer> <pack.json>'); process.exit(2); }
  const pack = JSON.parse(readFileSync(file, 'utf8'));
  const call = async (method, path, body) => {
    const r = await fetch(`${api}/organisations/${org}${path}`, { method: method.toUpperCase(), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  importDeadlineRules(call, pack).then((r) => { console.log(JSON.stringify(r, null, 2)); console.log('Imported as UNVERIFIED. Verification is for a holder of compliance:rule-verify who is not the importer (DEC-088).'); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
