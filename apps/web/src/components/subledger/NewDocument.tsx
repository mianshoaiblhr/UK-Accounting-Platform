'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api, errorText } from '@/lib/api';
import { qs, useApi, useWorkspace } from '@/lib/workspace';
import { SideNav } from './SideNav';
import { partyName, type Account, type Party, type Side, type TaxCode } from './side';

interface Line { description: string; quantity: string; unitPrice: string; accountId: string; vat: string }
const DEFAULT = '__default__', NONE = '__none__';
const blank = (vat: string): Line => ({ description: '', quantity: '1', unitPrice: '', accountId: '', vat });

/** New invoice or bill (M9b). Amounts are typed by the person and sent as entered; the API computes VAT and totals and the document page shows them. */
export function NewDocument({ side }: { side: Side }) {
  const w = useWorkspace();
  const router = useRouter();
  const parties = useApi<{ items: Party[] }>(w.path(`/contact-roles${qs({ role: side.role, limit: '100' })}`));
  const accounts = useApi<{ items: Account[] }>(w.path('/accounts'));
  const codes = useApi<{ items: TaxCode[] }>(w.path('/tax-codes'));
  const [partyId, setPartyId] = useState('');
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState('');
  const firstVat = side.partyDefaultVat ? DEFAULT : NONE;
  const [lines, setLines] = useState<Line[]>([blank(firstVat)]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const party = parties.data?.items.find((p) => p.id === partyId);
  const usable = (codes.data?.items ?? []).filter((c) => c.direction === side.vatDirection || c.direction === 'BOTH').filter((c) => side.key === 'purchases' || !c.reverseCharge);
  const defaultCode = (codes.data?.items ?? []).find((c) => c.id === party?.customer?.defaultTaxCodeId);
  const lineAccounts = (accounts.data?.items ?? []).filter((a) => side.lineAccountTypes.includes(a.type) && !a.isControl);
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const body = {
        [side.partyField]: partyId, issueDate, ...(reference.trim() ? { [side.supplierReference ? 'supplierReference' : 'customerReference']: reference.trim() } : {}),
        lines: lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, accountId: l.accountId,
          // sales (DEC-046): absent = the customer's default VAT code, null = no VAT code; purchases have no default, so "no code" is absent
          ...(l.vat === DEFAULT || (l.vat === NONE && !side.partyDefaultVat) ? {} : { taxCodeId: l.vat === NONE ? null : l.vat }) })),
      };
      const d = await api<{ id: string; warnings: string[] }>(w.path(side.doc.create), { body, idempotencyKey: crypto.randomUUID() });
      // the API returns a draft's warnings when it is written; the document page shows them on arrival
      try { sessionStorage.setItem(`draft-warnings:${d.id}`, JSON.stringify(d.warnings ?? [])); } catch { /* storage unavailable: the warnings are not repeated */ }
      router.push(`${w.base}/${side.key}/${d.id}`);
    } catch (err) { setError(errorText(err)); setBusy(false); }
  }

  return (
    <div className="card">
      <h1>New {side.doc.label.toLowerCase()}</h1>
      <SideNav side={side} />
      {[parties.error, accounts.error, codes.error].filter(Boolean).map((x) => <p key={x} className="error" role="alert">{x}</p>)}
      <form onSubmit={submit} data-testid="new-document">
        <div className="row">
          <div><label htmlFor="party">{side.party}</label>
            <select id="party" value={partyId} onChange={(e) => setPartyId(e.target.value)} required>
              <option value="">Choose…</option>
              {(parties.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{partyName(p)}</option>)}
            </select></div>
          <div><label htmlFor="issueDate">Issue date</label><input id="issueDate" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required /></div>
          <div><label htmlFor="reference">{side.supplierReference ? "Supplier's invoice number" : 'Customer reference (optional)'}</label>
            <input id="reference" value={reference} onChange={(e) => setReference(e.target.value)} required={side.supplierReference} /></div>
        </div>
        {side.partyDefaultVat && party && <p className="muted" data-testid="default-vat">Customer default VAT code: {defaultCode ? `${defaultCode.code} ${defaultCode.name}` : 'none'}</p>}
        <table data-testid="lines">
          <thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Account</th><th>VAT code</th><th /></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td><input aria-label={`Line ${i + 1} description`} value={l.description} onChange={(e) => set(i, { description: e.target.value })} required /></td>
                <td><input aria-label={`Line ${i + 1} quantity`} value={l.quantity} onChange={(e) => set(i, { quantity: e.target.value })} required /></td>
                <td><input aria-label={`Line ${i + 1} unit price`} value={l.unitPrice} onChange={(e) => set(i, { unitPrice: e.target.value })} required /></td>
                <td><select aria-label={`Line ${i + 1} account`} value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value })} required>
                  <option value="">Choose…</option>{lineAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                </select></td>
                <td><select aria-label={`Line ${i + 1} VAT code`} value={l.vat} onChange={(e) => set(i, { vat: e.target.value })}>
                  {side.partyDefaultVat && <option value={DEFAULT}>Customer default{defaultCode ? ` (${defaultCode.code})` : ''}</option>}
                  <option value={NONE}>No VAT code</option>
                  {usable.map((c) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}
                </select></td>
                <td>{lines.length > 1 && <button type="button" className="secondary" style={{ margin: 0 }} onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="secondary" onClick={() => setLines([...lines, blank(firstVat)])}>Add line</button>{' '}
        <button type="submit" disabled={busy}>{busy ? 'Please wait…' : `Save draft ${side.doc.label.toLowerCase()}`}</button>
        {error && <p className="error" role="alert">{error}</p>}
      </form>
    </div>
  );
}
