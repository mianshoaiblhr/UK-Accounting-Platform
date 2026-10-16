'use client';
import { useState, type FormEvent } from 'react';
import { api, errorText } from '@/lib/api';
import { qs, useApi, useWorkspace } from '@/lib/workspace';
import { useOverrides } from '../subledger/Overrides';
import type { Account, TaxCode } from '../subledger/side';
import { BankNav } from './BankAccounts';

interface Cash { id: string; direction: 'PAYMENT' | 'RECEIPT'; transactionDate: string; bankAccountId: string; reference: string | null; description: string; counterparty: string | null; net: string; vat: string; gross: string; status: string }
interface Line { description: string; accountId: string; amount: string; taxCodeId: string }
const isMoney = (a: Account) => a.subtype === 'CURRENT_ASSET_BANK' || a.subtype === 'CURRENT_ASSET_CASH';

/** Money in and out without a source document (M9c over M6c): VAT per line; the API refuses cash in hand below zero unless a reason is given. */
export function CashPage() {
  const w = useWorkspace();
  const list = useApi<{ items: Cash[] }>(w.path(`/cash-transactions${qs({ limit: '200' })}`));
  const accounts = useApi<{ items: Account[] }>(w.can('account:read') ? w.path('/accounts') : null);
  const codes = useApi<{ items: TaxCode[] }>(w.can('ledger:read') && w.can('cash:record') ? w.path('/tax-codes') : null);
  const [f, setF] = useState({ direction: 'PAYMENT' as 'PAYMENT' | 'RECEIPT', transactionDate: new Date().toISOString().slice(0, 10), bankAccountId: '', description: '', reference: '', counterparty: '' });
  const [lines, setLines] = useState<Line[]>([{ description: '', accountId: '', amount: '', taxCodeId: '' }]);
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  const ov = useOverrides();
  const rev = useOverrides();
  const [revReason, setRevReason] = useState<Record<string, string>>({});
  const all = accounts.data?.items ?? [];
  const name = (id: string) => { const a = all.find((x) => x.id === id); return a ? `${a.code} ${a.name}` : ''; };
  const lineAccounts = all.filter((a) => !a.isControl && !isMoney(a));
  const direction = f.direction === 'PAYMENT' ? 'PURCHASES' : 'SALES';
  const usable = (codes.data?.items ?? []).filter((c) => c.direction === direction || c.direction === 'BOTH').filter((c) => f.direction === 'PAYMENT' || !c.reverseCharge);
  const set = (i: number, p: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  async function record(e: FormEvent) {
    e.preventDefault(); setMsg({});
    try {
      await api(w.path('/cash-transactions'), { body: { direction: f.direction, transactionDate: f.transactionDate, bankAccountId: f.bankAccountId, description: f.description,
        ...(f.reference ? { reference: f.reference } : {}), ...(f.counterparty ? { counterparty: f.counterparty } : {}),
        lines: lines.map((l) => ({ description: l.description, accountId: l.accountId, amount: l.amount, ...(l.taxCodeId ? { taxCodeId: l.taxCodeId } : {}) })), ...ov.body() }, idempotencyKey: crypto.randomUUID() });
      ov.reset(); setLines([{ description: '', accountId: '', amount: '', taxCodeId: '' }]); setF({ ...f, description: '', reference: '', counterparty: '' }); setMsg({ ok: 'Recorded.' }); await list.reload();
    } catch (err) { if (!ov.take(err)) setMsg({ error: errorText(err) }); }
  }
  async function reverse(c: Cash) {
    setMsg({});
    try { await api(w.path(`/cash-transactions/${c.id}/reverse`), { body: { reason: revReason[c.id] ?? '', ...rev.body() }, idempotencyKey: crypto.randomUUID() }); rev.reset(); setMsg({ ok: 'Reversed.' }); await list.reload(); }
    catch (err) { if (!rev.take(err)) setMsg({ error: errorText(err) }); }
  }
  return (
    <>
      <div className="card">
        <h1>Cash transactions</h1>
        <BankNav />
        {list.error && <p className="error" role="alert">{list.error}</p>}
        {list.data && (list.data.items.length === 0 ? <p className="muted">None recorded.</p> : (
          <table data-testid="cash">
            <thead><tr><th>Date</th><th>In / out</th><th>Account</th><th>Description</th><th className="num">Net</th><th className="num">VAT</th><th className="num">Gross</th><th>Status</th><th /></tr></thead>
            <tbody>{list.data.items.map((c) => (
              <tr key={c.id}><td>{c.transactionDate}</td><td>{c.direction === 'RECEIPT' ? 'money in' : 'money out'}</td><td>{name(c.bankAccountId)}</td><td>{c.description}{c.counterparty ? ` · ${c.counterparty}` : ''}</td>
                <td className="num">{c.net}</td><td className="num">{c.vat}</td><td className="num">{c.gross}</td><td>{c.status}</td>
                <td>{c.status === 'POSTED' && w.can('cash:record') && <div className="inline-actions"><input aria-label={`Reason to reverse ${c.description}`} placeholder="Reason to reverse" value={revReason[c.id] ?? ''} onChange={(e) => setRevReason({ ...revReason, [c.id]: e.target.value })} />
                  <button className="secondary" onClick={() => reverse(c)}>Reverse</button></div>}</td></tr>
            ))}</tbody>
          </table>
        ))}
        {rev.view}
      </div>
      {w.can('cash:record') && (
        <div className="card" data-testid="record-cash">
          <h2>Record money in or out</h2>
          <form onSubmit={record}>
            <div className="row">
              <div><label htmlFor="c-direction">Direction</label><select id="c-direction" value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value as 'PAYMENT' | 'RECEIPT' })}><option value="PAYMENT">Money out</option><option value="RECEIPT">Money in</option></select></div>
              <div><label htmlFor="c-date">Date</label><input id="c-date" type="date" value={f.transactionDate} onChange={(e) => setF({ ...f, transactionDate: e.target.value })} required /></div>
              <div><label htmlFor="c-bank">Bank or cash account</label><select id="c-bank" value={f.bankAccountId} onChange={(e) => setF({ ...f, bankAccountId: e.target.value })} required><option value="">Choose…</option>{all.filter(isMoney).map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></div>
              <div><label htmlFor="c-desc">Description</label><input id="c-desc" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} required /></div>
              <div><label htmlFor="c-cp">Payee or payer</label><input id="c-cp" value={f.counterparty} onChange={(e) => setF({ ...f, counterparty: e.target.value })} /></div>
            </div>
            <table><thead><tr><th>Line</th><th>Account</th><th>Amount (excluding VAT)</th><th>VAT code</th></tr></thead>
              <tbody>{lines.map((l, i) => (
                <tr key={i}><td><input aria-label={`Cash line ${i + 1} description`} value={l.description} onChange={(e) => set(i, { description: e.target.value })} required /></td>
                  <td><select aria-label={`Cash line ${i + 1} account`} value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value })} required><option value="">Choose…</option>{lineAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></td>
                  <td><input aria-label={`Cash line ${i + 1} amount`} value={l.amount} onChange={(e) => set(i, { amount: e.target.value })} required /></td>
                  <td><select aria-label={`Cash line ${i + 1} VAT code`} value={l.taxCodeId} onChange={(e) => set(i, { taxCodeId: e.target.value })}><option value="">No VAT code</option>{usable.map((c) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}</select></td></tr>
              ))}</tbody></table>
            <button type="button" className="secondary" onClick={() => setLines([...lines, { description: '', accountId: '', amount: '', taxCodeId: '' }])}>Add line</button>{' '}
            {ov.view}
            <button type="submit">Record</button>
          </form>
        </div>
      )}
      {msg.ok && <p className="ok" role="status">{msg.ok}</p>}
      {msg.error && <p className="error" role="alert">{msg.error}</p>}
    </>
  );
}
