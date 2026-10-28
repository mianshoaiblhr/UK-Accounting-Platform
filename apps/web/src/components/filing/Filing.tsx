'use client';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Form } from '@/components/Form';
import { useYear } from '@/components/yearend/year';
import { ApiError, api, errorText } from '@/lib/api';
import { qs, useApi, useWorkspace } from '@/lib/workspace';

/**
 * V3-M4 (DEC-096): the year's iXBRL documents (DEC-094) and their Companies House filings (DEC-095) as the API returns them. The statuses, checks,
 * hashes and every refusal are the API's; the screen offers only the actions the person's permissions and the filing's status allow. The
 * Companies House connection is a fake: nothing reaches Companies House.
 */
interface IxbrlDocument { id: string; status: 'VALID' | 'INVALID'; sha256: string; factCount: number; contextCount: number; errors: string[]; warnings: string[]; at: string; notice: string }
interface FilingEvent { id: string; fromStatus: string | null; toStatus: string; byUserId: string; at: string; note: string | null; submissionId: string | null }
interface Filing {
  id: string; documentId: string; status: string; mode: string; payloadSha256: string; submissionId: string | null; chReference: string | null; acceptedOn: string | null;
  rejectionReasons: string[]; authority: { directorContactId: string | null; authorisedOn: string } | null; events: FilingEvent[]; notice: string;
}
const PATH = ['DRAFT', 'VALIDATED', 'AUTHORISED', 'SUBMITTED', 'ACCEPTED'];
const STEP_NAMES: Record<string, string> = { DRAFT: 'Draft', VALIDATED: 'Validated', AUTHORISED: 'Authorised', SUBMITTED: 'Submitted', ACCEPTED: 'Accepted', REJECTED: 'Rejected' };

function Steps({ f }: { f: Filing }) {
  const path = f.status === 'REJECTED' ? [...PATH.slice(0, 4), 'REJECTED'] : PATH;
  const at = path.indexOf(f.status);
  return (
    <ol className="steps" data-testid="filing-steps">
      {path.map((s, i) => <li key={s} className={i < at ? 'done' : i === at ? 'current' : ''} aria-current={i === at ? 'step' : undefined}>{STEP_NAMES[s]}</li>)}
    </ol>
  );
}

function FilingCard({ id, reload }: { id: string; reload: () => Promise<void> }) {
  const w = useWorkspace();
  const filing = useApi<Filing>(w.path(`/ch-filings/${id}`));
  const may = w.can('ixbrl:file');
  const { data: officers } = useApi<{ items: { role: string; contact: { id: string; name: string } }[] }>(may ? w.path('/officers') : null);
  const { data: docs } = useApi<{ items: { id: string; name: string }[] }>(may ? `/organisations/${w.orgId}/documents${qs({ companyId: w.company.id, limit: '100' })}` : null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [auth, setAuth] = useState({ directorContactId: '', authorisedOn: '', evidenceDocumentId: '' });
  const [rec, setRec] = useState({ reference: '', acceptedOn: '', evidenceDocumentId: '' });
  const f = filing.data;
  const refresh = async () => { await filing.reload(); await reload(); };
  async function step(path: string) {
    setBusy(true); setError('');
    try { await api(w.path(`/ch-filings/${id}/${path}`), { body: {}, idempotencyKey: crypto.randomUUID() }); await refresh(); }
    catch (e) { setError(e instanceof ApiError ? e.message : errorText(e)); } finally { setBusy(false); }
  }
  if (filing.error) return <p className="error" role="alert">{filing.error}</p>;
  if (!f) return null;
  const directors = (officers?.items ?? []).filter((o) => o.role === 'DIRECTOR');
  return (
    <div className="card" data-testid="ch-filing" data-status={f.status}>
      <h3>Companies House filing</h3>
      <Steps f={f} />
      {f.chReference && <p>Companies House reference <strong data-testid="ch-reference">{f.chReference}</strong>, accepted {f.acceptedOn}{f.mode === 'RECORDED' ? ' (filed outside the platform)' : ''}.</p>}
      {f.rejectionReasons.length > 0 && <ul className="error" data-testid="rejection">{f.rejectionReasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      {f.submissionId && <p className="muted">Submission {f.submissionId}</p>}
      <p className="muted">{f.notice}</p>
      {may && (
        <div className="inline-actions">
          {f.status === 'DRAFT' && <button disabled={busy} onClick={() => step('validate')}>Validate</button>}
          {f.status === 'AUTHORISED' && <button disabled={busy} onClick={() => step('submit')}>Submit to Companies House</button>}
          {f.status === 'SUBMITTED' && <button disabled={busy} onClick={() => step('status')}>Read the status</button>}
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {may && f.status === 'VALIDATED' && (
        <>
          <h4>The authority to file</h4>
          <Form submit="Record the authority" onSubmit={async () => { await api(w.path(`/ch-filings/${id}/authorise`), { body: auth, idempotencyKey: crypto.randomUUID() }); await refresh(); }}>
            <div className="row">
              <div><label htmlFor="au-director">Authorised by</label>
                <select id="au-director" required value={auth.directorContactId} onChange={(e) => setAuth({ ...auth, directorContactId: e.target.value })}>
                  <option value="">Choose a director</option>
                  {directors.map((o) => <option key={o.contact.id} value={o.contact.id}>{o.contact.name}</option>)}
                </select></div>
              <div><label htmlFor="au-date">Authorised on</label><input id="au-date" type="date" required value={auth.authorisedOn} onChange={(e) => setAuth({ ...auth, authorisedOn: e.target.value })} /></div>
              <div><label htmlFor="au-evidence">Evidence of the authority</label>
                <select id="au-evidence" required value={auth.evidenceDocumentId} onChange={(e) => setAuth({ ...auth, evidenceDocumentId: e.target.value })}>
                  <option value="">Choose a document</option>
                  {(docs?.items ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select></div>
            </div>
          </Form>
        </>
      )}
      {may && (f.status === 'VALIDATED' || f.status === 'AUTHORISED') && (
        <details>
          <summary>Filed outside the platform?</summary>
          <Form submit="Record the filing made elsewhere" onSubmit={async () => { await api(w.path(`/ch-filings/${id}/record`), { body: rec, idempotencyKey: crypto.randomUUID() }); await refresh(); }}>
            <div className="row">
              <div><label htmlFor="rc-ref">Companies House reference</label><input id="rc-ref" required value={rec.reference} onChange={(e) => setRec({ ...rec, reference: e.target.value })} /></div>
              <div><label htmlFor="rc-date">Accepted on</label><input id="rc-date" type="date" required value={rec.acceptedOn} onChange={(e) => setRec({ ...rec, acceptedOn: e.target.value })} /></div>
              <div><label htmlFor="rc-evidence">Evidence of acceptance</label>
                <select id="rc-evidence" required value={rec.evidenceDocumentId} onChange={(e) => setRec({ ...rec, evidenceDocumentId: e.target.value })}>
                  <option value="">Choose a document</option>
                  {(docs?.items ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select></div>
            </div>
          </Form>
        </details>
      )}
      <table data-testid="filing-events">
        <thead><tr><th>Step</th><th>When</th><th>Note</th></tr></thead>
        <tbody>{f.events.map((e) => <tr key={e.id}><td>{STEP_NAMES[e.toStatus] ?? e.toStatus}</td><td className="date">{e.at.slice(0, 16).replace('T', ' ')}</td><td>{e.note ?? ''}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

export function FilingScreen() {
  const w = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const { items, year, error, loaded } = useYear();
  const docs = useApi<{ items: IxbrlDocument[] }>(year ? w.path(`/ixbrl-documents${qs({ yearStart: year.yearStart })}`) : null);
  const filings = useApi<{ items: Filing[] }>(w.path('/ch-filings'));
  const reload = async () => { await docs.reload(); await filings.reload(); };
  const [actionError, setActionError] = useState('');
  const latest = docs.data?.items[0];
  const filingOf = (docId: string) => (filings.data?.items ?? []).filter((f) => f.documentId === docId);
  async function start(documentId: string) {
    setActionError('');
    try { await api(w.path('/ch-filings'), { body: { documentId }, idempotencyKey: crypto.randomUUID() }); await reload(); }
    catch (e) { setActionError(e instanceof ApiError ? e.message : errorText(e)); }
  }
  return (
    <>
      <div className="card">
        <h1>Accounts filing</h1>
        <p className="muted">The approved accounts as an inline XBRL document, checked, then filed with Companies House step by step. Each step is the API&apos;s, with its evidence.</p>
        {error && <p className="error" role="alert">{error}</p>}
        {loaded && items.length === 0 && <p className="muted" role="status">No financial year has a reporting framework yet.</p>}
        {year && (
          <div className="row" style={{ alignItems: 'center', gap: 12 }}>
            <label htmlFor="year-choice" style={{ margin: 0 }}>Financial year</label>
            <select id="year-choice" value={year.yearStart} style={{ width: 'auto' }} onChange={(e) => router.replace(`${pathname}${qs({ year: e.target.value })}`)}>
              {items.map((f) => <option key={f.id} value={f.yearStart}>{f.yearStart} to {f.yearEnd}{f.lockedAt ? ' (approved)' : ''}</option>)}
            </select>
          </div>
        )}
        {year && w.can('accounts:prepare') && (
          <Form submit="Generate the iXBRL document" onSubmit={async () => {
            const d = await api<IxbrlDocument>(w.path('/ixbrl-documents'), { body: { yearStart: year.yearStart }, idempotencyKey: crypto.randomUUID() });
            await reload();
            return d.status === 'VALID' ? 'Generated: the checks passed' : 'Generated with errors: see the checks';
          }}><span /></Form>
        )}
      </div>
      {docs.error && <p className="error" role="alert">{docs.error}</p>}
      {latest && (
        <div className="card" data-testid="ixbrl-document" data-status={latest.status}>
          <h2>iXBRL document</h2>
          <p><span className={`badge ${latest.status === 'VALID' ? 'status-DONE' : 'HIGH'}`} data-testid="document-status">{latest.status === 'VALID' ? 'Checks passed' : 'Checks failed'}</span>{' '}
            <a href={`/api/v1${w.path(`/ixbrl-documents/${latest.id}/content`)}`} target="_blank" rel="noreferrer">Open the document</a></p>
          <p className="muted">{latest.factCount} tagged facts in {latest.contextCount} contexts. SHA-256 <code>{latest.sha256}</code></p>
          {latest.errors.length > 0 && <><h3>Errors</h3><ul className="error" data-testid="document-errors">{latest.errors.map((x) => <li key={x}>{x}</li>)}</ul></>}
          {latest.warnings.length > 0 && <><h3>Warnings</h3><ul data-testid="document-warnings">{latest.warnings.map((x) => <li key={x}>{x}</li>)}</ul></>}
          <p className="muted">{latest.notice}</p>
          {filingOf(latest.id).length === 0 && w.can('ixbrl:file') && latest.status === 'VALID' && <button onClick={() => start(latest.id)}>Start the Companies House filing</button>}
          {actionError && <p className="error" role="alert">{actionError}</p>}
        </div>
      )}
      {latest && filingOf(latest.id).map((f) => <FilingCard key={f.id} id={f.id} reload={reload} />)}
    </>
  );
}
