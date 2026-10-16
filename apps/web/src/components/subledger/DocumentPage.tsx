'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, errorText } from '@/lib/api';
import { useApi, useWorkspace } from '@/lib/workspace';
import type { DocHeader } from './DocumentList';
import { useOverrides } from './Overrides';
import { SideNav } from './SideNav';
import type { Account, Side, TaxCode } from './side';

interface Doc extends DocHeader {
  journalId: string | null; warnings: string[]; creditReason?: string | null; debitReason?: string | null; discardedReason: string | null;
  originalInvoiceId?: string | null; originalBillId?: string | null; contactSnapshot: { name: string } | null;
  duplicateOverrideReason: string | null; creditLimitOverrideReason?: string | null;
  lines: { lineNo: number; description: string; quantity: string; unitPrice: string; accountId: string; taxCodeId: string | null; net: string; vat: string; gross: string }[];
  allocations: { id: string; amount: string; allocatedOn: string; receiptId?: string | null; paymentId?: string | null; creditId?: string | null; debitId?: string | null; realisedFx: string }[];
  creditNotes?: { id: string; documentNumber: string | null; status: string }[]; debitNotes?: { id: string; documentNumber: string | null; status: string }[];
}

export function DocumentPage({ side }: { side: Side }) {
  const w = useWorkspace();
  const router = useRouter();
  const { documentId } = useParams<{ documentId: string }>();
  const { data: d, error, reload } = useApi<Doc>(w.path(`${side.documents}/${documentId}`));
  const accounts = useApi<{ items: Account[] }>(w.can('account:read') ? w.path('/accounts') : null);
  const codes = useApi<{ items: TaxCode[] }>(w.can('ledger:read') ? w.path('/tax-codes') : null);
  const ov = useOverrides(side.approveFields);
  const [reason, setReason] = useState('');
  const [noteDate, setNoteDate] = useState(new Date().toISOString().slice(0, 10));
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  const [busy, setBusy] = useState(false);
  const [written] = useState<string[]>(() => {
    try { return JSON.parse(sessionStorage.getItem(`draft-warnings:${documentId}`) ?? '[]') as string[]; } catch { return []; }
  });
  if (error) return <div className="card"><p className="error" role="alert">{error}</p></div>;
  if (!d) return <div className="card"><p>Loading…</p></div>;
  const acc = (id: string) => accounts.data?.items.find((a) => a.id === id);
  const code = (id: string | null) => (id ? codes.data?.items.find((c) => c.id === id)?.code ?? id.slice(0, 8) : '');
  const isNote = d.kind === side.note.kind;
  const notes = d.creditNotes ?? d.debitNotes ?? [];
  const original = d.originalInvoiceId ?? d.originalBillId;

  async function act(path: string, body: object, done: string, after?: (r: { id: string }) => void) {
    setBusy(true); setMsg({});
    try {
      const r = await api<{ id: string }>(w.path(path), { body, idempotencyKey: crypto.randomUUID() });
      ov.reset(); setReason(''); setMsg({ ok: done });
      if (after) after(r); else await reload();
    } catch (e) { if (!ov.take(e)) setMsg({ error: errorText(e) }); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="card">
        <h1>{isNote ? side.note.label : side.doc.label} {d.documentNumber ?? '(draft)'}</h1>
        <SideNav side={side} />
        <p data-testid="doc-status">{d.status}{d.paymentStatus ? ` · ${d.paymentStatus}` : ''}</p>
        <p>{d.contactSnapshot?.name ?? ''} · issued {d.issueDate} · due {d.dueDate} · {d.currency}{d.supplierReference ? ` · supplier's number ${d.supplierReference}` : ''}{d.customerReference ? ` · ref ${d.customerReference}` : ''}</p>
        {original && <p>Corrects <Link href={`${w.base}/${side.key}/${original}`}>the original {side.doc.label.toLowerCase()}</Link>{d.creditReason || d.debitReason ? `: ${d.creditReason ?? d.debitReason}` : ''}</p>}
        {[...new Set([...d.warnings, ...(d.status === 'DRAFT' ? written : [])])].map((x) => <p key={x} className="error" data-testid="warning">{x}</p>)}
        <table data-testid="doc-lines">
          <thead><tr><th>#</th><th>Description</th><th className="num">Qty</th><th className="num">Unit price</th><th>Account</th><th>VAT code</th><th className="num">Net</th><th className="num">VAT</th><th className="num">Gross</th></tr></thead>
          <tbody>
            {d.lines.map((l) => (
              <tr key={l.lineNo}>
                <td>{l.lineNo}</td><td>{l.description}</td><td className="num">{l.quantity}</td><td className="num">{l.unitPrice}</td>
                <td>{acc(l.accountId) ? `${acc(l.accountId)!.code} ${acc(l.accountId)!.name}` : ''}</td><td data-testid="line-vat">{code(l.taxCodeId)}</td>
                <td className="num">{l.net}</td><td className="num">{l.vat}</td><td className="num">{l.gross}</td>
              </tr>
            ))}
            <tr className="total"><td colSpan={6}>Total</td><td className="num">{d.totals.net}</td><td className="num">{d.totals.vat}</td><td className="num" data-testid="doc-gross">{d.totals.gross}</td></tr>
          </tbody>
        </table>
        {d.status === 'APPROVED' && <p>Outstanding <strong data-testid="doc-outstanding">{d.outstanding}</strong></p>}
        {d.journalId && w.can('ledger:read') && <p><Link href={`${w.base}/journals/${d.journalId}`}>Open the journal</Link></p>}
        {d.duplicateOverrideReason && <p className="muted">Approved despite a possible duplicate: {d.duplicateOverrideReason}</p>}
        {d.creditLimitOverrideReason && <p className="muted">Approved over the credit limit: {d.creditLimitOverrideReason}</p>}
        {d.discardedReason && <p className="muted">Discarded: {d.discardedReason}</p>}
        {(d.allocations.length > 0 || notes.length > 0) && (
          <>
            <h2>Settlement</h2>
            <ul>
              {d.allocations.map((a) => <li key={a.id}>{a.allocatedOn}: {a.amount}{a.receiptId || a.paymentId ? ` from a ${side.money.label.toLowerCase()}` : ` by a ${side.note.label.toLowerCase()}`}{a.realisedFx !== '0.00' ? ` (exchange difference ${a.realisedFx})` : ''}</li>)}
              {notes.map((n) => <li key={n.id}><Link href={`${w.base}/${side.key}/${n.id}`}>{side.note.label} {n.documentNumber ?? '(draft)'}</Link> {n.status}</li>)}
            </ul>
          </>
        )}
      </div>
      <div className="card" data-testid="doc-actions">
        {d.status === 'DRAFT' && w.can(side.approve) && (
          <>
            {ov.view}
            <button disabled={busy} onClick={() => act(`${side.documents}/${d.id}/approve`, ov.body(), 'Approved.')}>Approve</button>
          </>
        )}
        {d.status === 'DRAFT' && w.can(side.manage) && (
          <div>
            <label htmlFor="discardReason">Reason to discard</label>
            <input id="discardReason" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="secondary" disabled={busy} onClick={() => act(`${side.documents}/${d.id}/discard`, { reason }, 'Discarded.')}>Discard</button>
          </div>
        )}
        {d.status === 'APPROVED' && !isNote && w.can(side.manage) && (
          <div>
            <h2>Full {side.note.label.toLowerCase()}</h2>
            <div className="row">
              <div><label htmlFor="noteDate">Issue date</label><input id="noteDate" type="date" value={noteDate} onChange={(e) => setNoteDate(e.target.value)} /></div>
              <div><label htmlFor="noteReason">Reason</label><input id="noteReason" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
            </div>
            <button disabled={busy} onClick={() => act(side.note.create, { [side.note.original]: d.id, issueDate: noteDate, reason }, `${side.note.label} drafted.`, (r) => router.push(`${w.base}/${side.key}/${r.id}`))}>
              Draft the {side.note.label.toLowerCase()}
            </button>
          </div>
        )}
        {msg.ok && <p className="ok" role="status">{msg.ok}</p>}
        {msg.error && <p className="error" role="alert">{msg.error}</p>}
      </div>
    </>
  );
}
