'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Form } from '@/components/Form';
import { BOX_NAMES, EVENT_NAMES, ReturnStatus, type Filing, type VatReturn } from '@/components/vat/common';
import { ApiError, api, errorText } from '@/lib/api';
import { WorkspaceShell, qs, useApi, useWorkspace } from '@/lib/workspace';

/**
 * V5-M3 (DEC-092): one VAT return, laid out as the prototype (DEC-079). The boxes, the reconciliation, the flags, the status, the sign-off and
 * whether a step lapsed are the API's (DEC-090); the filing package and the filings are the API's too (DEC-091). The screen offers only the
 * actions the person's permissions allow, and nothing here submits to HMRC (DEC-082, DEC-086).
 */
interface Package { package: { boxes: Record<string, string>; presentation: { method: string } }; sha256: string }

function Boxes({ r, pkg }: { r: VatReturn; pkg?: Package }) {
  return (
    <div className="card">
      <h2>The nine boxes</h2>
      <p className="muted">Figures in {r.workpaper.currency}{r.locked ? ', as the client approved them' : ', from the ledger as it stands'}. Open a box to see the lines it comes from.</p>
      <table data-testid="vat-boxes">
        <thead><tr><th>Box</th><th>Description</th><th className="num">Amount</th>{pkg && <th className="num">As filed</th>}</tr></thead>
        <tbody>{r.workpaper.boxes.map((b) => (
          <tr key={b.box} data-box={b.box}>
            <td>{b.box}</td>
            <td>
              {b.lines.length > 0 ? (
                <details>
                  <summary>{BOX_NAMES[b.box]}</summary>
                  <table data-testid={`box-${b.box}-lines`}>
                    <thead><tr><th>Journal</th><th>Line</th><th>Account</th><th>Code</th><th>Tax point</th><th className="num">Amount</th></tr></thead>
                    <tbody>{b.lines.map((l) => (
                      <tr key={`${l.journalId}-${l.lineNo}`}><td>{l.journalNumber}</td><td>{l.lineNo}</td><td>{l.accountCode}</td><td>{l.taxCode}</td><td className="date">{l.taxPoint}</td><td className="num">{l.amount}</td></tr>
                    ))}</tbody>
                  </table>
                </details>
              ) : BOX_NAMES[b.box]}
              {b.box === 5 && b.direction && <span className="muted"> ({b.direction === 'REPAYABLE' ? 'to reclaim' : 'to pay'})</span>}
            </td>
            <td className="num" data-testid={`box-${b.box}`}>{b.amount}</td>
            {pkg && <td className="num" data-testid={`filed-${b.box}`}>{pkg.package.boxes[String(b.box)]}</td>}
          </tr>
        ))}</tbody>
      </table>
      {pkg && <p className="muted">Boxes 6 to 9 are filed in whole pounds by the verified presentation rule ({pkg.package.presentation.method === 'TRUNCATE_PENCE' ? 'pence left out' : 'rounded to the pound'}).</p>}
    </div>
  );
}

function Checks({ r, reload }: { r: VatReturn; reload: () => Promise<void> }) {
  const w = useWorkspace();
  const may = !r.locked && (w.can('vat:prepare') || w.can('vat:review'));
  const [notes, setNotes] = useState<Record<string, string>>({});
  const rec = r.workpaper.reconciliation;
  return (
    <div className="card" data-testid="vat-checks">
      <h2>Checks against the ledger</h2>
      <table>
        <tbody>
          <tr><td>Movement on the VAT accounts in the period</td><td className="num">{rec.vatAccountMovement}</td></tr>
          <tr><td>VAT on the lines by tax point</td><td className="num">{rec.vatLinesByTaxPoint}</td></tr>
          <tr className="total"><td>Difference</td><td className="num" data-testid="reconciliation-difference">{rec.difference}</td></tr>
        </tbody>
      </table>
      {rec.explainedBy.length > 0 && (
        <table data-testid="reconciliation-entries">
          <thead><tr><th>Journal</th><th>Line</th><th>Dated</th><th>Tax point</th><th className="num">Amount</th><th>Why it differs</th></tr></thead>
          <tbody>{rec.explainedBy.map((e) => <tr key={`${e.journalId}-${e.lineNo}`}><td>{e.journalNumber}</td><td>{e.lineNo}</td><td className="date">{e.journalDate}</td><td className="date">{e.taxPoint ?? ''}</td><td className="num">{e.amount}</td><td>{e.reason}</td></tr>)}</tbody>
        </table>
      )}
      <h3>Review flags</h3>
      {r.flags.length === 0 ? <p className="muted" data-testid="no-flags">The return raises no flag.</p> : (
        <ul className="flags" data-testid="vat-flags">{r.flags.map((f) => (
          <li key={f.key} data-flag={f.key}>
            <p>{f.message}</p>
            {f.explanation ? <p className="ok" data-testid="flag-explanation">Explained: {f.explanation.note}</p> : <p className="error">Not explained yet</p>}
            {may && !f.explanation && (
              <Form submit="Save the explanation" onSubmit={async () => {
                await api(w.path(`/vat-returns/${r.id}/flag-explanations`), { body: { flagKey: f.key, explanation: notes[f.key] ?? '' }, idempotencyKey: crypto.randomUUID() });
                await reload();
              }}>
                <label htmlFor={`flag-${f.key}`}>Explanation</label>
                <input id={`flag-${f.key}`} required value={notes[f.key] ?? ''} onChange={(e) => setNotes({ ...notes, [f.key]: e.target.value })} />
              </Form>
            )}
          </li>
        ))}</ul>
      )}
    </div>
  );
}

function SignOff({ r, reload }: { r: VatReturn; reload: () => Promise<void> }) {
  const w = useWorkspace();
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const steps = r.events.filter((e) => e.kind !== 'FLAG_EXPLAINED');
  async function act(step: 'prepare' | 'review') {
    setBusy(true); setError('');
    try { await api(w.path(`/vat-returns/${r.id}/${step}`), { body: note.trim() ? { note: note.trim() } : {}, idempotencyKey: crypto.randomUUID() }); setNote(''); await reload(); }
    catch (e) { setError(e instanceof ApiError ? e.message : errorText(e)); } finally { setBusy(false); }
  }
  const canPrepare = !r.locked && w.can('vat:prepare') && r.status === 'DRAFT';
  const canReview = !r.locked && w.can('vat:review') && r.status === 'PREPARED';
  return (
    <div className="card" data-testid="sign-off">
      <h2>Sign-off</h2>
      {steps.length === 0 ? <p className="muted">Not prepared yet.</p> : (
        <table>
          <tbody>{steps.map((e) => (
            <tr key={e.id} data-event={e.kind}>
              <td>{EVENT_NAMES[e.kind]}</td>
              <td>{e.byName ?? e.byUserId}</td>
              <td className="date">{e.kind === 'CLIENT_APPROVED' ? e.approvedOn : e.at.slice(0, 10)}</td>
              <td>{e.live ? '' : <span className="badge MEDIUM" data-testid="lapsed">Lapsed: the ledger changed</span>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {(canPrepare || canReview) && (
        <div className="inline-actions">
          <input aria-label="Note (optional)" placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          {canPrepare && <button disabled={busy} onClick={() => act('prepare')}>Mark as prepared</button>}
          {canReview && <button disabled={busy} onClick={() => act('review')}>Record the review</button>}
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

function ClientApproval({ r, reload }: { r: VatReturn; reload: () => Promise<void> }) {
  const w = useWorkspace();
  const { data: contacts } = useApi<{ items: { id: string; name: string }[] }>(`/organisations/${w.orgId}/contacts${qs({ companyId: w.company.id, limit: '100' })}`);
  const { data: docs } = useApi<{ items: { id: string; name: string }[] }>(`/organisations/${w.orgId}/documents${qs({ companyId: w.company.id, limit: '100' })}`);
  const [v, setV] = useState({ approverContactId: '', approvedOn: '', evidenceDocumentId: '' });
  return (
    <div className="card">
      <h2>The client&apos;s approval</h2>
      <p className="muted">Recording it freezes the return and locks the VAT period: nothing more can be posted with a tax point inside it.</p>
      <Form submit="Record the approval and lock the period" onSubmit={async () => {
        await api(w.path(`/vat-returns/${r.id}/client-approval`), { body: v, idempotencyKey: crypto.randomUUID() });
        await reload();
        return 'Approved; the period is locked';
      }}>
        <div className="row">
          <div><label htmlFor="va-contact">Approved by</label>
            <select id="va-contact" required value={v.approverContactId} onChange={(e) => setV({ ...v, approverContactId: e.target.value })}>
              <option value="">Choose the client&apos;s contact</option>
              {(contacts?.items ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></div>
          <div><label htmlFor="va-date">Approved on</label><input id="va-date" type="date" required value={v.approvedOn} onChange={(e) => setV({ ...v, approvedOn: e.target.value })} /></div>
          <div><label htmlFor="va-evidence">Evidence (the client&apos;s approval)</label>
            <select id="va-evidence" required value={v.evidenceDocumentId} onChange={(e) => setV({ ...v, evidenceDocumentId: e.target.value })}>
              <option value="">Choose a document</option>
              {(docs?.items ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select></div>
        </div>
      </Form>
    </div>
  );
}

function Filings({ r, filings, reload }: { r: VatReturn; filings: Filing[]; reload: () => Promise<void> }) {
  const w = useWorkspace();
  const { data: docs } = useApi<{ items: { id: string; name: string }[] }>(r.locked && w.can('vat:file') ? `/organisations/${w.orgId}/documents${qs({ companyId: w.company.id, limit: '100' })}` : null);
  const [v, setV] = useState({ submittedOn: '', receiptReference: '', evidenceDocumentId: '', declared: false });
  const recorded = filings.some((f) => f.mode === 'RECORDED');
  const approval = r.events.find((e) => e.kind === 'CLIENT_APPROVED');
  return (
    <div className="card" data-testid="filings">
      <h2>Filing</h2>
      {filings.length === 0 ? <p className="muted">No filing is recorded.</p> : (
        <table>
          <thead><tr><th>Submitted</th><th>HMRC receipt</th><th>Kind</th></tr></thead>
          <tbody>{filings.map((f) => (
            <tr key={f.id} data-filing={f.mode}>
              <td className="date">{f.submittedOn}</td>
              <td>{f.receiptReference}</td>
              <td>{f.mode === 'SIMULATED' ? <span className="badge MEDIUM">Simulated: nothing was sent to HMRC</span> : <span className="badge status-DONE">Filed{f.journalId ? '; liability posted' : ''}</span>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {r.locked && !recorded && w.can('vat:file') && (
        <>
          <h3>Record the filing</h3>
          <p className="muted">The platform does not submit to HMRC. Submit the return as approved through HMRC-recognised software, then record HMRC&apos;s receipt here: this posts the VAT to the liability account and marks the deadline done.</p>
          <Form submit="Record the filing" onSubmit={async () => {
            await api(w.path(`/vat-returns/${r.id}/filings`), { body: { submittedOn: v.submittedOn, receiptReference: v.receiptReference.trim(), evidenceDocumentId: v.evidenceDocumentId, declarationConfirmed: v.declared }, idempotencyKey: crypto.randomUUID() });
            await reload();
            return 'Filing recorded';
          }}>
            <div className="row">
              <div><label htmlFor="vf-date">Submitted on</label><input id="vf-date" type="date" required value={v.submittedOn} onChange={(e) => setV({ ...v, submittedOn: e.target.value })} /></div>
              <div><label htmlFor="vf-ref">HMRC receipt reference (form bundle number)</label><input id="vf-ref" required inputMode="numeric" value={v.receiptReference} onChange={(e) => setV({ ...v, receiptReference: e.target.value })} /></div>
              <div><label htmlFor="vf-evidence">Evidence (HMRC&apos;s receipt)</label>
                <select id="vf-evidence" required value={v.evidenceDocumentId} onChange={(e) => setV({ ...v, evidenceDocumentId: e.target.value })}>
                  <option value="">Choose a document</option>
                  {(docs?.items ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select></div>
            </div>
            <p className="muted">When you submit this VAT information you are making a legal declaration that the information is true and complete. A false declaration can result in prosecution.</p>
            <label><input type="checkbox" checked={v.declared} onChange={(e) => setV({ ...v, declared: e.target.checked })} style={{ width: 'auto', marginRight: 8 }} />
              The return was submitted to HMRC as the client approved it{approval?.approvedOn ? ` on ${approval.approvedOn}` : ''}.</label>
          </Form>
        </>
      )}
    </div>
  );
}

function ReturnScreen() {
  const w = useWorkspace();
  const { returnId } = useParams<{ returnId: string }>();
  const ret = useApi<VatReturn>(w.path(`/vat-returns/${returnId}`));
  const r = ret.data;
  const pkg = useApi<Package>(r?.locked ? w.path(`/vat-returns/${returnId}/package`) : null);
  const filings = useApi<{ items: Filing[] }>(r?.locked ? w.path(`/vat-returns/${returnId}/filings`) : null);
  const reload = async () => { await ret.reload(); await filings.reload(); };
  return (
    <>
      <p><Link href={`${w.base}/vat-returns`}>VAT returns</Link></p>
      {ret.error && <p className="error" role="alert">{ret.error}</p>}
      {r && (
        <>
          <div className="card">
            <h1>VAT return for {r.periodFrom} to {r.periodTo}</h1>
            <p><ReturnStatus status={r.status} />{r.locked && <span className="muted"> The period is locked: nothing more can be posted into it.</span>}</p>
            {r.unexplainedFlags > 0 && <p className="error" data-testid="unexplained">{r.unexplainedFlags} review flag{r.unexplainedFlags === 1 ? '' : 's'} to explain before review.</p>}
            <p className="muted">{r.notice}</p>
          </div>
          <div className="split">
            <div>
              <Boxes r={r} pkg={pkg.data} />
              {r.locked && pkg.error && <p className="muted" data-testid="package-note">Filing package: {pkg.error}</p>}
              <Checks r={r} reload={reload} />
            </div>
            <div>
              <SignOff r={r} reload={reload} />
              {!r.locked && r.status === 'REVIEWED' && w.can('vat:review') && w.can('period:lock') && <ClientApproval r={r} reload={reload} />}
              {r.locked && <Filings r={r} filings={filings.data?.items ?? []} reload={reload} />}
            </div>
          </div>
        </>
      )}
    </>
  );
}

export default function Page() { return <WorkspaceShell need="ledger:read" feature="vat.returns"><ReturnScreen /></WorkspaceShell>; }
