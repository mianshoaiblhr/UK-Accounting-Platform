'use client';
import { useState, type FormEvent } from 'react';
import { api, errorText } from '@/lib/api';
import { qs, useApi, useWorkspace } from '@/lib/workspace';
import type { DocHeader } from './DocumentList';
import { useOverrides } from './Overrides';
import { SideNav } from './SideNav';
import { partyName, type Account, type Party, type Side } from './side';

interface Money { id: string; receiptDate?: string; paymentDate?: string; currency: string; amount: string; unallocated: string; reference: string | null; status: string;
  customerRoleId?: string; supplierRoleId?: string; bankDetailsUnverified?: boolean }

/** Receipts or payments (M9b): list, record into a bank or cash account with allocations to the party's open documents, reverse an unallocated one. */
export function MoneyPage({ side }: { side: Side }) {
  const w = useWorkspace();
  const list = useApi<{ items: Money[] }>(w.path(`${side.money.path}${qs({ limit: '200' })}`));
  const parties = useApi<{ items: Party[] }>(w.can('contact:read') ? w.path(`/contact-roles${qs({ role: side.role, status: 'ALL', limit: '100' })}`) : null);
  const accounts = useApi<{ items: Account[] }>(w.can(side.approve) && w.can('account:read') ? w.path('/accounts') : null);
  const [partyId, setPartyId] = useState('');
  const open = useApi<{ items: DocHeader[] }>(partyId ? w.path(`${side.documents}${qs({ [side.partyField]: partyId, kind: side.doc.kind, status: 'APPROVED', limit: '200' })}`) : null);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('');
  const [bank, setBank] = useState('');
  const [reference, setReference] = useState('');
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  const [busy, setBusy] = useState(false);
  const ov = useOverrides();
  const rev = useOverrides();
  const [revReason, setRevReason] = useState<Record<string, string>>({});
  const name = (id?: string) => partyName(parties.data?.items.find((p) => p.id === id));
  const banks = (accounts.data?.items ?? []).filter((a) => a.subtype === 'CURRENT_ASSET_BANK' || a.subtype === 'CURRENT_ASSET_CASH');
  const openDocs = (open.data?.items ?? []).filter((d) => d.outstanding !== '0.00' && Number(d.outstanding) !== 0);

  async function record(e: FormEvent) {
    e.preventDefault(); setBusy(true); setMsg({});
    try {
      const allocations = Object.entries(alloc).filter(([, v]) => v.trim()).map(([id, v]) => ({ [side.money.allocate]: id, amount: v.trim() }));
      await api(w.path(side.money.path), { body: { [side.partyField]: partyId, [side.money.date]: date, amount, bankAccountId: bank, ...(reference.trim() ? { reference: reference.trim() } : {}), allocations, ...ov.body() }, idempotencyKey: crypto.randomUUID() });
      ov.reset(); setAmount(''); setReference(''); setAlloc({}); setMsg({ ok: `${side.money.label} recorded.` });
      await Promise.all([list.reload(), open.reload()]);
    } catch (err) { if (!ov.take(err)) setMsg({ error: errorText(err) }); } finally { setBusy(false); }
  }
  async function reverse(m: Money) {
    setBusy(true); setMsg({});
    try {
      await api(w.path(`${side.money.path}/${m.id}/reverse`), { body: { reason: revReason[m.id] ?? '', ...rev.body() }, idempotencyKey: crypto.randomUUID() });
      rev.reset(); setMsg({ ok: `${side.money.label} reversed.` }); await list.reload();
    } catch (err) { if (!rev.take(err)) setMsg({ error: errorText(err) }); } finally { setBusy(false); }
  }

  return (
    <>
      <div className="card">
        <h1>{side.money.plural}</h1>
        <SideNav side={side} />
        {list.error && <p className="error" role="alert">{list.error}</p>}
        {list.data && (list.data.items.length === 0 ? <p className="muted">None recorded.</p> : (
          <table data-testid="money">
            <thead><tr><th>Date</th><th>{side.party}</th><th>Reference</th><th>Status</th><th className="num">Amount</th><th className="num">Unallocated</th><th /></tr></thead>
            <tbody>
              {list.data.items.map((m) => (
                <tr key={m.id}>
                  <td>{m.receiptDate ?? m.paymentDate}</td><td>{name(m[side.partyField])}</td><td>{m.reference ?? ''}{m.bankDetailsUnverified ? <span className="badge HIGH"> unverified bank details</span> : null}</td>
                  <td>{m.status}</td><td className="num">{m.amount} {m.currency}</td><td className="num">{m.unallocated}</td>
                  <td>{m.status === 'POSTED' && m.unallocated === m.amount && w.can(side.approve) && (
                    <div className="inline-actions">
                      <input aria-label={`Reason to reverse ${m.reference ?? m.id}`} placeholder="Reason to reverse" value={revReason[m.id] ?? ''} onChange={(e) => setRevReason({ ...revReason, [m.id]: e.target.value })} />
                      <button className="secondary" disabled={busy} onClick={() => reverse(m)}>Reverse</button>
                    </div>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
        {rev.view}
      </div>
      {w.can(side.approve) && (
        <div className="card" data-testid="record-money">
          <h2>Record a {side.money.label.toLowerCase()}</h2>
          <form onSubmit={record}>
            <div className="row">
              <div><label htmlFor="mparty">{side.party}</label>
                <select id="mparty" value={partyId} onChange={(e) => { setPartyId(e.target.value); setAlloc({}); }} required>
                  <option value="">Choose…</option>{(parties.data?.items ?? []).filter((p) => p.status === 'ACTIVE').map((p) => <option key={p.id} value={p.id}>{partyName(p)}</option>)}
                </select></div>
              <div><label htmlFor="mdate">Date</label><input id="mdate" type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></div>
              <div><label htmlFor="mamount">Amount</label><input id="mamount" value={amount} onChange={(e) => setAmount(e.target.value)} required /></div>
              <div><label htmlFor="mbank">Bank or cash account</label>
                <select id="mbank" value={bank} onChange={(e) => setBank(e.target.value)} required>
                  <option value="">Choose…</option>{banks.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                </select></div>
              <div><label htmlFor="mref">Reference</label><input id="mref" value={reference} onChange={(e) => setReference(e.target.value)} /></div>
            </div>
            {partyId && (openDocs.length === 0 ? <p className="muted">No open {side.doc.label.toLowerCase()}s: the amount stays unallocated.</p> : (
              <table data-testid="allocate">
                <thead><tr><th>{side.doc.label}</th><th>Due</th><th className="num">Outstanding</th><th className="num">Allocate</th></tr></thead>
                <tbody>{openDocs.map((d) => (
                  <tr key={d.id}><td>{d.documentNumber}{d.supplierReference ? ` · ${d.supplierReference}` : ''}</td><td>{d.dueDate}</td><td className="num">{d.outstanding}</td>
                    <td><input aria-label={`Allocate to ${d.documentNumber}`} value={alloc[d.id] ?? ''} onChange={(e) => setAlloc({ ...alloc, [d.id]: e.target.value })} /></td></tr>
                ))}</tbody>
              </table>
            ))}
            {ov.view}
            <button type="submit" disabled={busy}>{busy ? 'Please wait…' : `Record ${side.money.label.toLowerCase()}`}</button>
          </form>
        </div>
      )}
      {msg.ok && <p className="ok" role="status">{msg.ok}</p>}
      {msg.error && <p className="error" role="alert">{msg.error}</p>}
    </>
  );
}
