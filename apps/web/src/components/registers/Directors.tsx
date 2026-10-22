'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { Form } from '@/components/Form';
import { qs, useApi, useWorkspace } from '@/lib/workspace';
import { AccountSelect, Card, ContactSelect, Input, ReasonAction, RegistersNav } from './common';

/**
 * V2-M7b (DEC-074): director and shareholder loan accounts (DEC-062) - the accounts, a statement for a range, the report with its review
 * flags and the firm's thresholds - and related parties with their report. Balances, categories and flags are the API's.
 */
interface Loan { id: string; contactName: string | null; kind: string; accountCode: string | null; accountName: string | null; openedOn: string; status: 'ACTIVE' | 'CLOSED'; closedOn: string | null }
interface Summary { opening: string; closing: string; lowest: string; lowestOn: string; daysOverdrawn: number; flags: string[]; notEvaluated: string[]; notice: string }
interface Statement extends Loan { statement: Summary & { movements: { journalId: string; journalNumber: number; date: string; description: string; amount: string; category: string; balance: string }[] } }
interface Report { from: string; to: string; flagged: number; items: (Loan & Summary & { movementCount: number })[] }
interface Thresholds { current: { largeMovement: string | null; overdrawn: string | null; reason: string; setAt: string } | null; notice: string }
interface Party { id: string; contactName: string | null; relationship: string; description: string; fromDate: string; toDate: string | null; status: 'ACTIVE' | 'ENDED' }
interface PartyReport { from: string; to: string; notice: string; items: (Party & { figures: Record<string, { amount: string } | unknown[]> })[] }
const RELATIONSHIPS = ['DIRECTOR', 'CLOSE_FAMILY_OF_DIRECTOR', 'SHAREHOLDER', 'ENTITY_CONTROLLED_BY_DIRECTOR', 'KEY_MANAGEMENT', 'PARENT', 'SUBSIDIARY', 'FELLOW_SUBSIDIARY', 'ASSOCIATE', 'JOINT_VENTURE', 'OTHER'];
const useRange = () => { const y = new Date().getUTCFullYear(); return useState({ from: `${y}-01-01`, to: `${y}-12-31` }); };
function Range({ id, range, setRange }: { id: string; range: { from: string; to: string }; setRange: (r: { from: string; to: string }) => void }) {
  return <div className="row"><Input id={`${id}-from`} label="From" type="date" value={range.from} onChange={(x) => setRange({ ...range, from: x })} /><Input id={`${id}-to`} label="To" type="date" value={range.to} onChange={(x) => setRange({ ...range, to: x })} /></div>;
}

function StatementView({ id, range }: { id: string; range: { from: string; to: string } }) {
  const w = useWorkspace();
  const { data, error } = useApi<Statement>(w.path(`/director-loan-accounts/${id}/statement${qs(range)}`));
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!data) return null;
  const s = data.statement;
  return (
    <div data-testid="loan-statement">
      <p>Opening <span className="num">{s.opening}</span>; closing <strong data-testid="loan-closing">{s.closing}</strong> (credit-positive; negative means overdrawn); most overdrawn {s.lowest} on {s.lowestOn}; {s.daysOverdrawn} day(s) overdrawn.</p>
      {s.flags.length > 0 && <p className="error">Review prompts: {s.flags.join(', ')}</p>}
      {s.notEvaluated.length > 0 && <p className="muted">Not evaluated (no threshold set): {s.notEvaluated.join(', ')}</p>}
      <table><thead><tr><th>Date</th><th>Journal</th><th>Description</th><th>Category</th><th className="num">Amount</th><th className="num">Balance</th></tr></thead>
        <tbody>{s.movements.map((m) => <tr key={m.journalId}><td>{m.date}</td><td>#{m.journalNumber}</td><td>{m.description}</td><td>{m.category}</td><td className="num">{m.amount}</td><td className="num">{m.balance}</td></tr>)}</tbody>
      </table>
      <p className="muted">{s.notice}</p>
    </div>
  );
}

export function DirectorsScreen() {
  const w = useWorkspace();
  const [range, setRange] = useRange();
  const list = useApi<{ items: Loan[] }>(w.path('/director-loan-accounts'));
  const report = useApi<Report>(w.path(`/director-loan-accounts/report${qs(range)}`));
  const thresholds = useApi<Thresholds>(w.path('/director-loan-thresholds'));
  const [open, setOpen] = useState<string | null>(null);
  const [v, setV] = useState({ contactId: '', kind: 'DIRECTOR', accountId: '', openedOn: '', notes: '' });
  const [t, setT] = useState({ largeMovement: '', overdrawn: '', reason: '' });
  const prepare = w.can('accounts:prepare');
  const reload = async () => { await Promise.all([list.reload(), report.reload(), thresholds.reload()]); };
  return (
    <>
      <div className="card">
        <h1>Director loan accounts</h1>
        <RegistersNav />
        <Range id="dl" range={range} setRange={setRange} />
        {list.error && <p className="error" role="alert">{list.error}</p>}
        <table data-testid="loan-accounts"><thead><tr><th>Person</th><th>Kind</th><th>Account</th><th>Opened</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>{(list.data?.items ?? []).map((l) => (
            <tr key={l.id} data-loan={l.contactName ?? ''}><td><button className="secondary" style={{ margin: 0 }} onClick={() => setOpen(open === l.id ? null : l.id)}>{l.contactName}</button></td><td>{l.kind}</td><td>{l.accountCode} {l.accountName}</td><td>{l.openedOn}</td>
              <td>{l.status}{l.closedOn ? ` ${l.closedOn}` : ''}</td><td>{prepare && l.status === 'ACTIVE' && <ReasonAction label="Close" path={`/director-loan-accounts/${l.id}/close`} extra={{ closedOn: range.to }} onDone={reload} />}</td></tr>
          ))}</tbody>
        </table>
        {open && <StatementView id={open} range={range} />}
        {prepare && (
          <>
            <h3>Open a loan account</h3>
            <Form submit="Open the account" success="Loan account opened" onSubmit={async () => {
              await api(w.path('/director-loan-accounts'), { body: { contactId: v.contactId, kind: v.kind, accountId: v.accountId, openedOn: v.openedOn, ...(v.notes.trim() ? { notes: v.notes.trim() } : {}) } });
              await reload();
            }}>
              <div className="row">
                <ContactSelect id="dl-contact" label="Director or shareholder" value={v.contactId} onChange={(x) => setV({ ...v, contactId: x })} />
                <div><label htmlFor="dl-kind">Kind</label><select id="dl-kind" value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}><option value="DIRECTOR">Director</option><option value="SHAREHOLDER">Shareholder</option><option value="DIRECTOR_AND_SHAREHOLDER">Director and shareholder</option></select></div>
                <AccountSelect id="dl-account" label="Ledger account" value={v.accountId} onChange={(x) => setV({ ...v, accountId: x })} filter={(a) => a.type === 'LIABILITY' || a.type === 'ASSET'} />
                <Input id="dl-opened" label="Opened on" type="date" value={v.openedOn} onChange={(x) => setV({ ...v, openedOn: x })} />
              </div>
            </Form>
          </>
        )}
      </div>
      <Card title="Report" testId="loan-report">
        {report.error && <p className="error" role="alert">{report.error}</p>}
        {report.data && (
          <>
            <p>{report.data.flagged} account(s) flagged for review from {report.data.from} to {report.data.to}.</p>
            <table><thead><tr><th>Person</th><th className="num">Opening</th><th className="num">Closing</th><th className="num">Most overdrawn</th><th>Prompts</th></tr></thead>
              <tbody>{report.data.items.map((r) => <tr key={r.id}><td>{r.contactName}</td><td className="num">{r.opening}</td><td className="num">{r.closing}</td><td className="num">{r.lowest}</td><td>{r.flags.join(', ') || '-'}</td></tr>)}</tbody>
            </table>
          </>
        )}
      </Card>
      <Card title="The firm's review thresholds" testId="loan-thresholds">
        {thresholds.data && (
          <>
            <p className="muted">{thresholds.data.notice}</p>
            <p>Large movement: {thresholds.data.current?.largeMovement ?? 'not set'}; overdrawn above: {thresholds.data.current?.overdrawn ?? 'not set'}</p>
            {prepare && (
              <Form submit="Set the thresholds" success="Thresholds set" onSubmit={async () => {
                await api(w.path('/director-loan-thresholds'), { method: 'PUT', body: { largeMovement: t.largeMovement.trim() || null, overdrawn: t.overdrawn.trim() || null, reason: t.reason.trim() } }); await reload();
              }}>
                <div className="row">
                  <Input id="th-large" label="Large movement" value={t.largeMovement} onChange={(x) => setT({ ...t, largeMovement: x })} required={false} />
                  <Input id="th-over" label="Overdrawn above" value={t.overdrawn} onChange={(x) => setT({ ...t, overdrawn: x })} required={false} />
                </div>
                <Input id="th-reason" label="Reason" value={t.reason} onChange={(x) => setT({ ...t, reason: x })} />
              </Form>
            )}
          </>
        )}
      </Card>
    </>
  );
}

export function RelatedPartiesScreen() {
  const w = useWorkspace();
  const [range, setRange] = useRange();
  const list = useApi<{ items: Party[] }>(w.path('/related-parties'));
  const report = useApi<PartyReport>(w.path(`/related-parties/report${qs(range)}`));
  const [v, setV] = useState({ contactId: '', relationship: 'DIRECTOR', description: '', fromDate: '' });
  const prepare = w.can('accounts:prepare');
  const reload = async () => { await Promise.all([list.reload(), report.reload()]); };
  const fig = (x: unknown) => (x && typeof x === 'object' && 'amount' in x ? (x as { amount: string }).amount : '');
  return (
    <>
      <div className="card">
        <h1>Related parties</h1>
        <RegistersNav />
        {list.error && <p className="error" role="alert">{list.error}</p>}
        <table data-testid="parties"><thead><tr><th>Party</th><th>Relationship</th><th>Description</th><th>From</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>{(list.data?.items ?? []).map((p) => <tr key={p.id} data-party={p.contactName ?? ''}><td>{p.contactName}</td><td>{p.relationship}</td><td>{p.description}</td><td>{p.fromDate}{p.toDate ? ` to ${p.toDate}` : ''}</td><td>{p.status}</td>
            <td>{prepare && p.status === 'ACTIVE' && <ReasonAction label="End" path={`/related-parties/${p.id}/end`} extra={{ toDate: range.to }} onDone={reload} />}</td></tr>)}</tbody>
        </table>
        {prepare && (
          <>
            <h3>Record a related party</h3>
            <Form submit="Record the party" success="Related party recorded" onSubmit={async () => {
              await api(w.path('/related-parties'), { body: { contactId: v.contactId, relationship: v.relationship, description: v.description.trim(), fromDate: v.fromDate } }); await reload();
            }}>
              <div className="row">
                <ContactSelect id="rp-contact" label="Party" value={v.contactId} onChange={(x) => setV({ ...v, contactId: x })} />
                <div><label htmlFor="rp-rel">Relationship</label><select id="rp-rel" value={v.relationship} onChange={(e) => setV({ ...v, relationship: e.target.value })}>{RELATIONSHIPS.map((r) => <option key={r} value={r}>{r}</option>)}</select></div>
                <Input id="rp-desc" label="Description" value={v.description} onChange={(x) => setV({ ...v, description: x })} />
                <Input id="rp-from" label="From" type="date" value={v.fromDate} onChange={(x) => setV({ ...v, fromDate: x })} />
              </div>
            </Form>
          </>
        )}
      </div>
      <Card title="Transactions report" testId="party-report">
        <Range id="rpr" range={range} setRange={setRange} />
        {report.error && <p className="error" role="alert">{report.error}</p>}
        {report.data && (
          <>
            <p className="muted">{report.data.notice}</p>
            <table><thead><tr><th>Party</th><th className="num">Sales</th><th className="num">Purchases</th><th className="num">Cash paid</th><th className="num">Cash received</th><th className="num">Owed by</th><th className="num">Owed to</th></tr></thead>
              <tbody>{report.data.items.map((p) => <tr key={p.id} data-party={p.contactName ?? ''}><td>{p.contactName}</td>{['sales', 'purchases', 'cashPaid', 'cashReceived', 'owedBy', 'owedTo'].map((k) => <td key={k} className="num">{fig(p.figures[k])}</td>)}</tr>)}</tbody>
            </table>
          </>
        )}
      </Card>
    </>
  );
}
