'use client';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, errorText } from '@/lib/api';
import { qs, useApi, useWorkspace } from '@/lib/workspace';
import { useOverrides } from '../subledger/Overrides';
import { BankNav, type BankAccount } from './BankAccounts';

interface Candidate { journalLineId: string; journalId: string; journalNumber: number; date: string; sourceType: string; reference: string | null; description: string | null; amount: string; score: number; reasons: string[] }
interface Suggestion { statementLineId: string; date: string; description: string; reference: string | null; unmatched: string; ambiguous: boolean; candidates: Candidate[]; proposal: { kind: 'CHARGE' | 'INTEREST'; accountId: string | null } | null }
interface Item { id: string; date: string; description: string | null; reference: string | null; amount: string; unmatched: string; ageDays: number; journalNumber?: number; sourceType?: string }
interface Unmatched { currency: string; asOf: string; statement: { count: number; total: string; items: Item[] }; ledger: { count: number; total: string; items: Item[] } }
interface Proof { asOf: string; statementBalance: string; unmatchedStatement: string; adjustedStatement: string; ledgerBalance: string; unmatchedLedger: string; adjustedLedger: string; difference: string; reconciled: boolean; explanation: string; lastSignOff: { asAt: string } | null }
interface LineDetail { id: string; matches: { id: string; journalNumber: number | null; amount: string; kind: string; status: string }[] }

/** Reconciliation of one bank account (M9c): the API suggests and proves; the person decides and signs off. Nothing here computes a balance. */
export function Reconcile() {
  const w = useWorkspace();
  const { bankAccountId } = useParams<{ bankAccountId: string }>();
  const b = (p: string) => w.path(`/bank-accounts/${bankAccountId}${p}`);
  const account = useApi<BankAccount>(b(''));
  const sugg = useApi<{ notice: string; items: Suggestion[] }>(b('/suggestions'));
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const open = useApi<Unmatched>(b(`/unmatched${qs({ asOf })}`));
  const proof = useApi<Proof>(b(`/reconciliation${qs({ asOf })}`));
  const signs = useApi<{ items: { id: string; asAt: string; bankClosingBalance: string; statementBalance: string; signedAt: string }[] }>(b('/reconciliations'));
  const matched = useApi<{ items: MatchedLine[] }>(b(`/statement-lines${qs({ status: 'MATCHED', limit: '500' })}`));
  const ov = useOverrides();
  const [pick, setPick] = useState({ line: '', ledger: '' });
  const [closing, setClosing] = useState('');
  const [detail, setDetail] = useState<Record<string, LineDetail>>({});
  const [reason, setReason] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok?: string; error?: string }>({});
  const canRec = w.can('bank:reconcile');
  const refresh = () => Promise.all([sugg.reload(), open.reload(), proof.reload(), signs.reload(), account.reload(), matched.reload()]);
  async function run(path: string, body: object, ok: string) {
    setMsg({});
    try { await api(w.path(path), { body: { ...body, ...ov.body() }, idempotencyKey: crypto.randomUUID() }); ov.reset(); setMsg({ ok }); setDetail({}); await refresh(); }
    catch (err) { if (!ov.take(err)) setMsg({ error: errorText(err) }); }
  }
  async function showMatches(lineId: string) {
    try { setDetail({ ...detail, [lineId]: await api<LineDetail>(w.path(`/statement-lines/${lineId}`)) }); } catch (err) { setMsg({ error: errorText(err) }); }
  }

  return (
    <>
      <div className="card">
        <h1>Reconcile{account.data ? `: ${account.data.name}` : ''}</h1>
        <BankNav />
        <div className="row"><div><label htmlFor="asOf">As at</label><input id="asOf" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></div></div>
        {proof.error && <p className="error" role="alert">{proof.error}</p>}
        {proof.data && (
          <table data-testid="proof">
            <tbody>
              <tr><td>Statement balance</td><td className="num">{proof.data.statementBalance}</td><td>Ledger balance</td><td className="num">{proof.data.ledgerBalance}</td></tr>
              <tr><td>Statement lines not yet matched</td><td className="num">{proof.data.unmatchedStatement}</td><td>Ledger entries not yet matched</td><td className="num">{proof.data.unmatchedLedger}</td></tr>
              <tr className="total"><td>Adjusted statement</td><td className="num">{proof.data.adjustedStatement}</td><td>Adjusted ledger</td><td className="num">{proof.data.adjustedLedger}</td></tr>
              <tr className="total"><td colSpan={3}>Difference</td><td className="num" data-testid="proof-difference">{proof.data.difference}</td></tr>
            </tbody>
          </table>
        )}
        {proof.data && <p className={proof.data.reconciled ? 'ok' : 'error'} role="status" data-testid="proof-status">{proof.data.reconciled ? 'Reconciled' : 'Not reconciled'}: {proof.data.explanation}</p>}
        {canRec && proof.data?.reconciled && (
          <div className="row" data-testid="sign-off">
            <div><label htmlFor="closing">Closing balance on the bank's statement at {asOf}</label><input id="closing" value={closing} onChange={(e) => setClosing(e.target.value)} /></div>
            <div><button onClick={() => run(`/bank-accounts/${bankAccountId}/reconciliations`, { asOf, bankClosingBalance: closing }, 'Reconciliation signed off.')}>Sign off</button></div>
          </div>
        )}
        {signs.data && signs.data.items.length > 0 && <p className="muted" data-testid="sign-offs">Signed off: {signs.data.items.map((s) => `${s.asAt} (bank ${s.bankClosingBalance})`).join(', ')}</p>}
        {ov.view}
        {msg.ok && <p className="ok" role="status" data-testid="rec-msg">{msg.ok}</p>}
        {msg.error && <p className="error" role="alert" data-testid="rec-error">{msg.error}</p>}
      </div>
      <div className="card">
        <h2>Suggestions</h2>
        {sugg.data && <p className="muted">{sugg.data.notice}</p>}
        {sugg.data && (sugg.data.items.length === 0 ? <p className="muted">No suggestions.</p> : (
          <table data-testid="suggestions">
            <thead><tr><th>Statement line</th><th className="num">Unmatched</th><th>Suggested</th></tr></thead>
            <tbody>{sugg.data.items.map((s) => (
              <tr key={s.statementLineId} data-line={s.description}>
                <td>{s.date} {s.description}{s.reference ? ` (${s.reference})` : ''}{s.ambiguous ? <span className="badge MEDIUM"> more than one candidate</span> : null}</td>
                <td className="num">{s.unmatched}</td>
                <td>
                  {s.candidates.map((c) => (
                    <div key={c.journalLineId}>journal {c.journalNumber} · {c.date} · {c.sourceType} · {c.amount} <span className="muted">({c.reasons.join(', ')})</span>
                      {canRec && <button className="secondary" style={{ margin: '0 0 0 8px', padding: '2px 8px' }} onClick={() => run('/bank-matches', { statementLineId: s.statementLineId, journalLineId: c.journalLineId, fromSuggestion: true }, 'Matched.')}>Match</button>}</div>
                  ))}
                  {s.proposal && canRec && <button className="secondary" style={{ margin: 0, padding: '2px 8px' }} onClick={() => run(`/statement-lines/${s.statementLineId}/post`, { kind: s.proposal!.kind }, `Posted as ${s.proposal!.kind.toLowerCase()} and matched.`)}>Post as {s.proposal.kind === 'CHARGE' ? 'bank charge' : 'interest'}</button>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        ))}
      </div>
      <div className="card">
        <h2>Not yet matched as at {open.data?.asOf ?? asOf}</h2>
        {open.data && (
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div>
              <h2>Statement ({open.data.statement.count}, {open.data.statement.total})</h2>
              <table data-testid="open-statement"><tbody>{open.data.statement.items.map((i) => (
                <tr key={i.id}><td>{canRec && <input type="radio" name="line" aria-label={`Statement line ${i.description}`} style={{ width: 'auto' }} checked={pick.line === i.id} onChange={() => setPick({ ...pick, line: i.id })} />}</td>
                  <td>{i.date} {i.description}</td><td className="num">{i.unmatched}</td><td className="muted">{i.ageDays} d</td></tr>
              ))}</tbody></table>
            </div>
            <div>
              <h2>Ledger ({open.data.ledger.count}, {open.data.ledger.total})</h2>
              <table data-testid="open-ledger"><tbody>{open.data.ledger.items.map((i) => (
                <tr key={i.id}><td>{canRec && <input type="radio" name="ledger" aria-label={`Ledger entry ${i.journalNumber}`} style={{ width: 'auto' }} checked={pick.ledger === i.id} onChange={() => setPick({ ...pick, ledger: i.id })} />}</td>
                  <td>{i.date} journal {i.journalNumber} {i.sourceType}</td><td className="num">{i.unmatched}</td></tr>
              ))}</tbody></table>
            </div>
          </div>
        )}
        {canRec && <button disabled={!pick.line || !pick.ledger} onClick={() => run('/bank-matches', { statementLineId: pick.line, journalLineId: pick.ledger }, 'Matched.')}>Match the selected pair</button>}
      </div>
      <MatchedLines lines={matched.data?.items ?? []} canRec={canRec} detail={detail} showMatches={showMatches} reason={reason} setReason={setReason}
        unmatch={(id) => run(`/bank-matches/${id}/unmatch`, { reason: reason[id] ?? '' }, 'Match undone.')} />
    </>
  );
}

interface MatchedLine { id: string; date: string; description: string; amount: string; matched: string; status: string }
function MatchedLines({ lines, canRec, detail, showMatches, reason, setReason, unmatch }: { lines: MatchedLine[]; canRec: boolean; detail: Record<string, LineDetail>; showMatches: (id: string) => void;
  reason: Record<string, string>; setReason: (r: Record<string, string>) => void; unmatch: (matchId: string) => void }) {
  if (lines.length === 0) return null;
  return (
    <div className="card">
      <h2>Matched lines</h2>
      <table data-testid="matched-lines"><tbody>{lines.map((l) => (
        <tr key={l.id}><td>{l.date} {l.description}</td><td className="num">{l.amount}</td>
          <td>{!detail[l.id] ? <button className="secondary" style={{ margin: 0, padding: '2px 8px' }} onClick={() => showMatches(l.id)}>Show matches</button> : detail[l.id]!.matches.filter((m) => m.status === 'ACTIVE').map((m) => (
            <div key={m.id} className="inline-actions">journal {m.journalNumber} · {m.amount} · {m.kind.toLowerCase().replace(/_/g, ' ')}
              {canRec && <><input aria-label="Reason to undo the match" placeholder="Reason to undo" value={reason[m.id] ?? ''} onChange={(e) => setReason({ ...reason, [m.id]: e.target.value })} />
                <button className="secondary" onClick={() => unmatch(m.id)}>Undo match</button></>}</div>
          ))}</td></tr>
      ))}</tbody></table>
    </div>
  );
}
