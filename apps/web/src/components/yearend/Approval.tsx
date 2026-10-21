'use client';
import { useState } from 'react';
import { ApiError, api, errorText } from '@/lib/api';
import { Form } from '@/components/Form';
import { qs, useApi, useWorkspace } from '@/lib/workspace';
import { YearBar, useYear } from './year';

/**
 * V2-M7a (DEC-071): partner review, client approval and the filing-ready package (DEC-070) as the API returns them. The fingerprint, the
 * states, the lock and every refusal are the API's; the screen only offers the actions the person's permissions allow.
 */
interface StepView { step: number; state: string; control: { status: string | null; summary: string } }
interface Status {
  fingerprint: string | null; locked: boolean; lockedAt: string | null; steps: StepView[];
  partnerReviews: { id: string; fingerprint: string; live: boolean; note: string | null; byUserId: string; at: string }[];
  clientApproval: { fingerprint: string; current: boolean; directorContactId: string; approvedOn: string; evidenceDocumentId: string; note: string | null; at: string } | null;
  package: { id: string; fingerprint: string; sha256: string; at: string } | null;
}
interface Package { sha256: string; fingerprint: string; at: string; content: Record<string, unknown> }
const TITLES: Record<number, string> = { 12: 'Partner review', 13: 'Client approval', 14: 'Filing-ready package' };

function ClientApprovalForm({ yearStart, onDone }: { yearStart: string; onDone: () => Promise<void> }) {
  const w = useWorkspace();
  const { data: officers } = useApi<{ items: { role: string; contact: { id: string; name: string } }[] }>(w.path('/officers'));
  const { data: docs } = useApi<{ items: { id: string; name: string }[] }>(`/organisations/${w.orgId}/documents${qs({ companyId: w.company.id, limit: '100' })}`);
  const [v, setV] = useState({ directorContactId: '', approvedOn: '', evidenceDocumentId: '', note: '' });
  return (
    <Form submit="Record the client's approval and lock the year" onSubmit={async () => {
      await api(w.path('/accounts-approval/client-approval'), { body: { yearStart, directorContactId: v.directorContactId, approvedOn: v.approvedOn, evidenceDocumentId: v.evidenceDocumentId, ...(v.note.trim() ? { note: v.note.trim() } : {}) } });
      await onDone();
      return 'Approved; the year is locked';
    }}>
      <div className="row">
        <div><label htmlFor="ap-director">Approving director</label>
          <select id="ap-director" value={v.directorContactId} onChange={(e) => setV({ ...v, directorContactId: e.target.value })} required>
            <option value="">Choose a director</option>
            {(officers?.items ?? []).filter((o) => o.role === 'DIRECTOR').map((o) => <option key={o.contact.id} value={o.contact.id}>{o.contact.name}</option>)}
          </select></div>
        <div><label htmlFor="ap-date">Approved on</label><input id="ap-date" type="date" value={v.approvedOn} onChange={(e) => setV({ ...v, approvedOn: e.target.value })} required /></div>
        <div><label htmlFor="ap-evidence">Evidence (the signed approval)</label>
          <select id="ap-evidence" value={v.evidenceDocumentId} onChange={(e) => setV({ ...v, evidenceDocumentId: e.target.value })} required>
            <option value="">Choose a document</option>
            {(docs?.items ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select></div>
      </div>
      <label htmlFor="ap-note">Note (optional)</label><input id="ap-note" value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} />
    </Form>
  );
}

function PackageView({ yearStart }: { yearStart: string }) {
  const w = useWorkspace();
  const { data, error } = useApi<Package>(w.path(`/accounts-package${qs({ yearStart })}`));
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!data) return null;
  // the package exactly as stored, saved as a file; nothing is changed or recomputed
  const href = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(data.content, null, 2))}`;
  return (
    <div data-testid="package">
      <p>Generated {data.at.slice(0, 16).replace('T', ' ')}. SHA-256 <code data-testid="package-sha256">{data.sha256}</code></p>
      <p>Fingerprint of the approved accounts <code>{data.fingerprint}</code></p>
      <a href={href} download={`accounts-package-${yearStart}.json`}>Save the package (JSON)</a>
      <p className="muted">{(data.content.notices as string[] | undefined)?.join(' ')}</p>
    </div>
  );
}

export function ApprovalScreen() {
  const w = useWorkspace();
  const { year } = useYear();
  const { data, error, reload } = useApi<Status>(year ? w.path(`/accounts-approval${qs({ yearStart: year.yearStart })}`) : null);
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const step = (n: number) => data?.steps.find((s) => s.step === n);
  async function act(path: string, body: object) {
    setBusy(true); setActionError('');
    try { await api(w.path(path), { body }); await reload(); }
    catch (e) { setActionError(e instanceof ApiError ? `${e.message} (${e.code})` : errorText(e)); } finally { setBusy(false); }
  }
  return (
    <div className="card">
      <YearBar title="Approval" locked={data?.locked} />
      {error && <p className="error" role="alert">{error}</p>}
      {data && year && (
        <>
          <table data-testid="approval-steps">
            <thead><tr><th>#</th><th>Step</th><th>State</th><th>Control</th></tr></thead>
            <tbody>{data.steps.map((s) => (
              <tr key={s.step} data-step={s.step}><td>{s.step}</td><td>{TITLES[s.step]}</td><td data-testid="step-state"><span className="badge">{s.state}</span></td><td>{s.control.status}: {s.control.summary}</td></tr>
            ))}</tbody>
          </table>
          <p className="muted">Fingerprint of the accounts as they stand: <code data-testid="fingerprint">{data.fingerprint ?? 'none (the accounts document is not complete)'}</code></p>
          {actionError && <p className="error" role="alert">{actionError}</p>}

          <h2>Partner review</h2>
          {data.partnerReviews.length === 0 ? <p className="muted">No partner review yet.</p> : (
            <ul data-testid="partner-reviews">{data.partnerReviews.map((r) => <li key={r.id}>{r.at.slice(0, 16).replace('T', ' ')} {r.live ? '(live)' : '(lapsed: the accounts changed)'}{r.note ? `: ${r.note}` : ''}</li>)}</ul>
          )}
          {w.can('accounts:review') && !data.locked && step(12)?.state !== 'DONE' && (
            <button disabled={busy} onClick={() => act('/accounts-approval/partner-review', { yearStart: year.yearStart })}>Record the partner review</button>
          )}

          <h2>Client approval</h2>
          {data.clientApproval ? (
            <p data-testid="client-approval">Approved on {data.clientApproval.approvedOn}{data.clientApproval.current ? '' : ' (the accounts changed since)'}{data.clientApproval.note ? `: ${data.clientApproval.note}` : ''}. The year is locked.</p>
          ) : w.can('accounts:review') && w.can('period:lock') ? <ClientApprovalForm yearStart={year.yearStart} onDone={reload} /> : <p className="muted">Not recorded.</p>}

          <h2>Filing-ready package</h2>
          {data.package ? <PackageView yearStart={year.yearStart} /> : (
            <>
              <p className="muted">Not generated. The package is the platform&apos;s filing-ready output, not a filing.</p>
              {w.can('accounts:prepare') && data.clientApproval && <button disabled={busy} onClick={() => act('/accounts-package', { yearStart: year.yearStart })}>Generate the package</button>}
            </>
          )}
        </>
      )}
    </div>
  );
}
