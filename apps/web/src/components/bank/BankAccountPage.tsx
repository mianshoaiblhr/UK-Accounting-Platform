'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api, errorText } from '@/lib/api';
import { qs, useApi, useWorkspace } from '@/lib/workspace';
import { useOverrides } from '../subledger/Overrides';
import { BankNav, type BankAccount } from './BankAccounts';

export interface StatementLine { id: string; lineNo: number; date: string; description: string; reference: string | null; amount: string; balance: string | null; matched: string; unmatched: string; status: string }
interface Import { id: string; status: string; rowsRead: number | null; rowsImported: number | null; rowsDuplicate: number | null; errors: { row: number; message: string }[]; firstDate: string | null; lastDate: string | null; requestedAt: string; voidReason: string | null }
const FORMATS = ['DD/MM/YYYY', 'YYYY-MM-DD', 'DD-MM-YYYY', 'MM/DD/YYYY', 'DD MMM YYYY', 'DD/MM/YY'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const guess = (cols: string[], ...names: RegExp[]) => cols.find((c) => names.some((n) => n.test(c))) ?? '';

export function BankAccountPage() {
  const w = useWorkspace();
  const { bankAccountId } = useParams<{ bankAccountId: string }>();
  const account = useApi<BankAccount>(w.path(`/bank-accounts/${bankAccountId}`));
  const [status, setStatus] = useState('');
  const lines = useApi<{ currency: string; items: StatementLine[] }>(w.path(`/bank-accounts/${bankAccountId}/statement-lines${qs({ status, limit: '500' })}`));
  const imports = useApi<{ items: Import[] }>(w.path(`/bank-accounts/${bankAccountId}/statement-imports`));
  const ov = useOverrides();
  const [file, setFile] = useState<File>();
  const [cols, setCols] = useState<string[]>([]);
  const [m, setM] = useState({ dateColumn: '', dateFormat: 'DD/MM/YYYY', descriptionColumn: '', referenceColumn: '', mode: 'inout', amountColumn: '', moneyInColumn: '', moneyOutColumn: '', balanceColumn: '' });
  const [progress, setProgress] = useState('');
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  const [voidReason, setVoidReason] = useState<Record<string, string>>({});

  async function choose(f: File | undefined) {
    setFile(f); setCols([]);
    if (!f) return;
    // the header row is read here only to offer the column names; the API parses the file
    const first = (await f.slice(0, 4096).text()).split(/\r?\n/)[0] ?? '';
    const c = first.split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean);
    setCols(c);
    setM({ ...m, dateColumn: guess(c, /date/i), descriptionColumn: guess(c, /desc|detail|narrative/i), referenceColumn: guess(c, /^ref/i), amountColumn: guess(c, /^amount/i),
      moneyInColumn: guess(c, /paid in|credit|money in/i), moneyOutColumn: guess(c, /paid out|debit|money out/i), balanceColumn: guess(c, /balance/i), mode: guess(c, /^amount/i) ? 'amount' : 'inout' });
  }

  async function upload(f: File) {
    const contentType = f.type || 'text/csv';
    const c = await api<{ document: { id: string }; version: { id: string }; upload: { url: string; method?: string; headers?: Record<string, string>; via: 'api' | 'presigned' } }>(
      `/organisations/${w.orgId}/documents`, { body: { name: f.name, companyId: w.company.id, contentType, sizeBytes: f.size }, idempotencyKey: crypto.randomUUID() });
    const r = await fetch(c.upload.url, { method: c.upload.method ?? 'PUT', credentials: 'same-origin', headers: c.upload.headers ?? { 'Content-Type': contentType }, body: f });
    if (!r.ok) throw new Error(`The upload was refused (${r.status})`);
    if (c.upload.via === 'presigned') await api(`/organisations/${w.orgId}/documents/${c.document.id}/versions/${c.version.id}/complete`, { method: 'POST' });
    for (let i = 0; i < 120; i++) { // the file is virus-scanned before it can be used
      const d = await api<{ versions: { id: string; status: string }[] }>(`/organisations/${w.orgId}/documents/${c.document.id}`);
      const v = d.versions.find((x) => x.id === c.version.id);
      if (v?.status === 'AVAILABLE') return { documentId: c.document.id, versionId: c.version.id };
      if (v && ['QUARANTINED', 'FAILED'].includes(v.status)) throw new Error(`The file was not accepted (${v.status.toLowerCase()})`);
      setProgress(`Checking the file… (${v?.status.toLowerCase() ?? 'uploading'})`); await sleep(500);
    }
    throw new Error('The file check is taking too long; try again later');
  }

  async function runImport(e: FormEvent) {
    e.preventDefault(); if (!file) return; setMsg({}); setProgress('Uploading…');
    try {
      const doc = await upload(file);
      const mapping = { hasHeader: true, delimiter: ',', dateColumn: m.dateColumn, dateFormat: m.dateFormat, descriptionColumn: m.descriptionColumn,
        ...(m.referenceColumn ? { referenceColumn: m.referenceColumn } : {}), ...(m.balanceColumn ? { balanceColumn: m.balanceColumn } : {}),
        ...(m.mode === 'amount' ? { amountColumn: m.amountColumn } : { moneyInColumn: m.moneyInColumn, moneyOutColumn: m.moneyOutColumn }) };
      let imp = await api<Import>(w.path(`/bank-accounts/${bankAccountId}/statement-imports`), { body: { ...doc, mapping, ...ov.body() }, idempotencyKey: crypto.randomUUID() });
      for (let i = 0; i < 240 && imp.status === 'QUEUED'; i++) { setProgress('Importing…'); await sleep(500); imp = await api<Import>(w.path(`/statement-imports/${imp.id}`)); }
      setProgress(''); ov.reset();
      if (imp.status === 'COMPLETED') setMsg({ ok: `Imported ${imp.rowsImported} line(s)${imp.rowsDuplicate ? `, ${imp.rowsDuplicate} already present` : ''}.` });
      else setMsg({ error: imp.status === 'FAILED' ? `Nothing was imported: ${imp.errors.map((x) => `row ${x.row}: ${x.message}`).join('; ')}` : `The import is ${imp.status.toLowerCase()}` });
      await Promise.all([lines.reload(), imports.reload(), account.reload()]);
    } catch (err) { setProgress(''); if (!ov.take(err)) setMsg({ error: errorText(err) }); }
  }

  async function voidImport(id: string) {
    setMsg({});
    try { await api(w.path(`/statement-imports/${id}/void`), { body: { reason: voidReason[id] ?? '' } }); setMsg({ ok: 'Import voided.' }); await Promise.all([lines.reload(), imports.reload()]); }
    catch (err) { setMsg({ error: errorText(err) }); }
  }

  const a = account.data;
  const colSelect = (k: keyof typeof m, label: string, optional = false) => (
    <div><label htmlFor={`map-${k}`}>{label}</label>
      <select id={`map-${k}`} value={m[k]} onChange={(e) => setM({ ...m, [k]: e.target.value })} required={!optional}>
        <option value="">{optional ? 'Not in the file' : 'Choose…'}</option>{cols.map((c) => <option key={c} value={c}>{c}</option>)}
      </select></div>
  );
  return (
    <>
      <div className="card">
        <h1>{a ? a.name : 'Bank account'}</h1>
        <BankNav />
        {account.error && <p className="error" role="alert">{account.error}</p>}
        {a && <p data-testid="bank-summary">{a.accountCode} {a.accountName} · {a.detailsMasked ?? 'no details'} · ledger {a.ledgerBalance} {a.currency} · statement {a.statement.balance} · {a.statement.unmatchedLines} unmatched line(s)</p>}
        {a && <p><Link href={`${w.base}/bank/${a.id}/reconcile`}>Reconcile this account</Link></p>}
        <div className="row"><div><label htmlFor="lineStatus">Lines</label>
          <select id="lineStatus" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option><option value="UNMATCHED">Unmatched</option><option value="PARTIAL">Partly matched</option><option value="MATCHED">Matched</option><option value="VOID">Void</option>
          </select></div></div>
        {lines.data && (lines.data.items.length === 0 ? <p className="muted">No statement lines.</p> : (
          <table data-testid="statement-lines">
            <thead><tr><th>Date</th><th>Description</th><th>Reference</th><th className="num">Amount</th><th className="num">Unmatched</th><th>Status</th></tr></thead>
            <tbody>{lines.data.items.map((l) => <tr key={l.id}><td>{l.date}</td><td>{l.description}</td><td>{l.reference ?? ''}</td><td className="num">{l.amount}</td><td className="num">{l.unmatched}</td><td>{l.status}</td></tr>)}</tbody>
          </table>
        ))}
      </div>
      <div className="card">
        <h2>Statement imports</h2>
        {imports.data && (imports.data.items.length === 0 ? <p className="muted">None yet.</p> : (
          <table data-testid="imports">
            <thead><tr><th>Requested</th><th>Status</th><th>Lines</th><th>Dates</th><th /></tr></thead>
            <tbody>{imports.data.items.map((i) => (
              <tr key={i.id}><td>{i.requestedAt.slice(0, 16).replace('T', ' ')}</td><td>{i.status}{i.voidReason ? ` (${i.voidReason})` : ''}</td>
                <td>{i.rowsImported ?? '-'} of {i.rowsRead ?? '-'}{i.rowsDuplicate ? `, ${i.rowsDuplicate} already present` : ''}</td><td>{i.firstDate ?? ''} {i.lastDate ? `to ${i.lastDate}` : ''}</td>
                <td>{i.status === 'COMPLETED' && w.can('bank:manage') && (
                  <div className="inline-actions"><input aria-label="Reason to void" placeholder="Reason to void" value={voidReason[i.id] ?? ''} onChange={(e) => setVoidReason({ ...voidReason, [i.id]: e.target.value })} />
                    <button className="secondary" onClick={() => voidImport(i.id)}>Void</button></div>
                )}</td></tr>
            ))}</tbody>
          </table>
        ))}
        {w.can('bank:manage') && (
          <form onSubmit={runImport} data-testid="import-form">
            <h2>Import a CSV statement</h2>
            <label htmlFor="csv">Statement file (CSV)</label>
            <input id="csv" type="file" accept=".csv,text/csv" onChange={(e) => choose(e.target.files?.[0])} required />
            {cols.length > 0 && (
              <>
                <div className="row">{colSelect('dateColumn', 'Date column')}
                  <div><label htmlFor="map-dateFormat">Date format</label><select id="map-dateFormat" value={m.dateFormat} onChange={(e) => setM({ ...m, dateFormat: e.target.value })}>{FORMATS.map((x) => <option key={x}>{x}</option>)}</select></div>
                  {colSelect('descriptionColumn', 'Description column')}{colSelect('referenceColumn', 'Reference column', true)}</div>
                <div className="row">
                  <div><label htmlFor="map-mode">Amounts</label><select id="map-mode" value={m.mode} onChange={(e) => setM({ ...m, mode: e.target.value })}>
                    <option value="inout">Money in and money out columns</option><option value="amount">One signed amount column</option></select></div>
                  {m.mode === 'amount' ? colSelect('amountColumn', 'Amount column') : <>{colSelect('moneyInColumn', 'Money in column')}{colSelect('moneyOutColumn', 'Money out column')}</>}
                  {colSelect('balanceColumn', 'Balance column', true)}
                </div>
              </>
            )}
            {ov.view}
            <button type="submit" disabled={!!progress || cols.length === 0}>{progress || 'Import statement'}</button>
          </form>
        )}
        {msg.ok && <p className="ok" role="status">{msg.ok}</p>}
        {msg.error && <p className="error" role="alert">{msg.error}</p>}
      </div>
    </>
  );
}
