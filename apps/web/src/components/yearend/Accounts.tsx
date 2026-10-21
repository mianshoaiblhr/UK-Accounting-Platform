'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { Form } from '@/components/Form';
import { qs, useApi, useWorkspace } from '@/lib/workspace';
import { Notices, YearBar, useYear } from './year';

/**
 * V2-M7a (DEC-071): the accounts document (DEC-063) as the API renders it - statements, wording, tables, omitted items, problems and notices -
 * with the preparer's facts and the size test (DEC-066). Every amount and word is the API's.
 */
interface Line { key: string; name: string; kind: 'ACCOUNTS' | 'TOTAL' | 'RETAINED_PROFIT'; depth: number; amount: string; comparative?: string }
type Block = { type: 'text'; text: string } | { type: 'table'; key: string; columns: string[]; rows: string[][] };
interface Doc {
  companyName: string; companyNumber: string | null; currency: string; year: { start: string; end: string; priorEnd: string; entitySize: string };
  standard: { name: string }; version: { label: string; status: string }; verified: boolean; complete: boolean;
  statements: { profitAndLoss: Line[]; balanceSheet: Line[]; cashFlow: { sections: { section: string; lines: { key: string; name: string; amount: string; comparative?: string }[]; total: { name: string; amount: string; comparative?: string } }[] } | null };
  sections: { section: string; items: { key: string; title: string; blocks: Block[]; missing: string[] }[] }[];
  omitted: { key: string; title: string; reason: string }[]; problems: string[]; notices: string[];
}
interface Fact { key: string; value: string; reason: string; setAt: string }
interface SizeTest { chosen: string; qualifiesAs: string; fits: boolean | null; verified: boolean; problems: string[]; notices: string[] }
const SECTION_TITLES: Record<string, string> = { POLICIES: 'Accounting policies', NOTES: 'Notes', DIRECTORS_REPORT: "Directors' report", BALANCE_SHEET_STATEMENTS: 'Balance sheet statements' };
const FACT_KEYS = ['employees.average', 'employees.averagePrior', 'approval.date', 'approval.director', 'size.priorMet', 'size.priorStatus'];

function Lines({ title, lines, d }: { title: string; lines: Line[]; d: Doc }) {
  return (
    <>
      <h2>{title}</h2>
      <table data-testid={`statement-${title === 'Profit and loss account' ? 'pl' : 'bs'}`}>
        <thead><tr><th>{d.currency}</th><th className="num">{d.year.end}</th><th className="num">{d.year.priorEnd}</th></tr></thead>
        <tbody>{lines.map((l) => (
          <tr key={l.key} data-key={l.key} className={l.kind === 'ACCOUNTS' ? undefined : 'total'}>
            <td style={{ paddingLeft: 8 + l.depth * 16 }}>{l.name}</td><td className="num">{l.amount}</td><td className="num">{l.comparative ?? ''}</td>
          </tr>
        ))}</tbody>
      </table>
    </>
  );
}

function Facts({ yearStart, onChange }: { yearStart: string; onChange: () => Promise<void> }) {
  const w = useWorkspace();
  const { data, error, reload } = useApi<{ current: Fact[] }>(w.path(`/accounts-facts${qs({ yearStart })}`));
  const { data: officers } = useApi<{ items: { role: string; contact: { id: string; name: string } }[] }>(w.path('/officers'));
  const [key, setKey] = useState(FACT_KEYS[0]!);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const directors = (officers?.items ?? []).filter((o) => o.role === 'DIRECTOR');
  const name = (v: string) => directors.find((o) => o.contact.id === v)?.contact.name ?? v;
  return (
    <div className="card" data-testid="facts">
      <h2>Facts for the accounts</h2>
      {error && <p className="error" role="alert">{error}</p>}
      {data && (data.current.length === 0 ? <p className="muted">No facts entered.</p> : (
        <table><thead><tr><th>Fact</th><th>Value</th><th>Reason</th><th>Set</th></tr></thead>
          <tbody>{data.current.map((f) => <tr key={f.key} data-fact={f.key}><td>{f.key}</td><td>{f.key === 'approval.director' ? name(f.value) : f.value}</td><td>{f.reason}</td><td className="muted">{f.setAt.slice(0, 16).replace('T', ' ')}</td></tr>)}</tbody>
        </table>
      ))}
      {w.can('accounts:prepare') && (
        <Form submit="Set fact" success="Fact set" onSubmit={async () => {
          await api(w.path('/accounts-facts'), { body: { yearStart, key, value: value.trim(), reason: reason.trim() } });
          setValue(''); setReason(''); await reload(); await onChange();
        }}>
          <div className="row">
            <div><label htmlFor="fact-key">Fact</label>
              <select id="fact-key" value={key} onChange={(e) => { setKey(e.target.value); setValue(''); }}>{FACT_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}</select></div>
            <div><label htmlFor="fact-value">Value</label>
              {key === 'approval.director'
                ? <select id="fact-value" value={value} onChange={(e) => setValue(e.target.value)} required><option value="">Choose a director</option>{directors.map((o) => <option key={o.contact.id} value={o.contact.id}>{o.contact.name}</option>)}</select>
                : <input id="fact-value" type={key === 'approval.date' ? 'date' : 'text'} value={value} onChange={(e) => setValue(e.target.value)} required />}</div>
          </div>
          <label htmlFor="fact-reason">Reason</label><input id="fact-reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
        </Form>
      )}
    </div>
  );
}

export function AccountsScreen() {
  const w = useWorkspace();
  const { year } = useYear();
  const q = year ? qs({ yearStart: year.yearStart }) : '';
  const doc = useApi<Doc>(year ? w.path(`/accounts-document${q}`) : null);
  const size = useApi<SizeTest>(year ? w.path(`/size-test${q}`) : null);
  const d = doc.data;
  return (
    <>
      <div className="card">
        <YearBar title="Accounts" />
        {doc.error && <p className="error" role="alert">{doc.error}</p>}
        {d && (
          <div data-testid="accounts-document">
            <p><strong>{d.companyName}</strong>{d.companyNumber ? ` (${d.companyNumber})` : ''}: {d.standard.name}, {d.version.label} ({d.version.status}), {d.year.entitySize}</p>
            <p data-testid="document-complete" className={d.complete ? 'ok' : 'error'}>{d.complete ? 'The accounts document is complete.' : 'The accounts document is not complete.'}</p>
            <Notices notices={d.notices} />
            {d.problems.length > 0 && <><h2>Problems</h2><ul data-testid="problems">{d.problems.map((p) => <li key={p} className="error">{p}</li>)}</ul></>}
            <Lines title="Profit and loss account" lines={d.statements.profitAndLoss} d={d} />
            <Lines title="Balance sheet" lines={d.statements.balanceSheet} d={d} />
            {d.statements.cashFlow && (
              <>
                <h2>Cash flow statement</h2>
                <table data-testid="statement-cf"><tbody>{d.statements.cashFlow.sections.flatMap((s) => [
                  ...s.lines.map((l) => <tr key={`${s.section}-${l.key}`}><td>{l.name}</td><td className="num">{l.amount}</td><td className="num">{l.comparative ?? ''}</td></tr>),
                  <tr key={`${s.section}-total`} className="total"><td>{s.total.name}</td><td className="num">{s.total.amount}</td><td className="num">{s.total.comparative ?? ''}</td></tr>,
                ])}</tbody></table>
              </>
            )}
            {d.sections.map((s) => (
              <section key={s.section} data-section={s.section}>
                <h2>{SECTION_TITLES[s.section] ?? s.section}</h2>
                {s.items.map((i) => (
                  <div key={i.key} data-item={i.key}>
                    <h3>{i.title}</h3>
                    {i.blocks.map((b, n) => b.type === 'text' ? <p key={n}>{b.text}</p> : (
                      <table key={n}><thead><tr>{b.columns.map((c, k) => <th key={k}>{c}</th>)}</tr></thead><tbody>{b.rows.map((r, k) => <tr key={k}>{r.map((c, m) => <td key={m} className={m ? 'num' : undefined}>{c}</td>)}</tr>)}</tbody></table>
                    ))}
                  </div>
                ))}
              </section>
            ))}
            {d.omitted.length > 0 && <p className="muted">Omitted: {d.omitted.map((o) => `${o.title} (${o.reason === 'EMPTY' ? 'nothing to disclose' : 'not for this size'})`).join('; ')}</p>}
          </div>
        )}
      </div>
      {year && <Facts yearStart={year.yearStart} onChange={doc.reload} />}
      <div className="card" data-testid="size-test">
        <h2>Size test</h2>
        {size.error && <p className="error" role="alert">{size.error}</p>}
        {size.data && (
          <>
            <p>Chosen: <strong>{size.data.chosen}</strong>; qualifies as: <strong>{size.data.qualifiesAs}</strong>; {size.data.fits === null ? 'cannot be decided' : size.data.fits ? 'the chosen size fits' : 'the chosen size does not fit'}{size.data.verified ? '' : ' (unverified thresholds)'}</p>
            {size.data.problems.length > 0 && <ul>{size.data.problems.map((p) => <li key={p} className="error">{p}</li>)}</ul>}
            <Notices notices={size.data.notices} />
          </>
        )}
      </div>
    </>
  );
}
