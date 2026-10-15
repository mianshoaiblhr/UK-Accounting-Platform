'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { WorkspaceShell, qs, useApi, useWorkspace } from '@/lib/workspace';

interface Source {
  journal: { id: string; journalNumber: number; journalDate: string; sourceType: string; sourceReference: string | null; description: string; total: string; reversesJournalId: string | null };
  lines: { lineNo: number; accountId: string; accountCode: string | null; accountName: string | null; debit: string; credit: string; description: string | null }[];
  source: (Record<string, unknown> & { entityType: string; id: string; restricted?: boolean; requires?: string; attachments?: Record<string, unknown>[] }) | null;
  sourceResolver: string;
  journalAttachments: Record<string, unknown>[];
  bankMatches: { id: string; statementLineId: string; amount: string }[];
}
const HIDDEN = new Set(['entityType', 'id', 'attachments', 'restricted', 'requires']);

function JournalPage() {
  const w = useWorkspace();
  const { journalId } = useParams<{ journalId: string }>();
  const { data, error } = useApi<Source>(w.path(`/journals/${journalId}/source`));
  if (error) return <div className="card"><p className="error" role="alert">{error}</p></div>;
  if (!data) return <div className="card"><p>Loading…</p></div>;
  const j = data.journal;
  return (
    <>
      <div className="card">
        <h1>Journal {j.journalNumber}</h1>
        <p>{j.journalDate} · {j.sourceType}{j.sourceReference ? ` · ${j.sourceReference}` : ''} · total {j.total}</p>
        <p>{j.description}</p>
        {j.reversesJournalId && <p>Reverses <Link href={`${w.base}/journals/${j.reversesJournalId}`}>the original journal</Link>.</p>}
        <table data-testid="journal-lines">
          <thead><tr><th>#</th><th>Account</th><th>Description</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
          <tbody>
            {data.lines.map((l) => (
              <tr key={l.lineNo}>
                <td>{l.lineNo}</td>
                <td><Link href={`${w.base}/ledger${qs({ accountId: l.accountId, to: j.journalDate })}`}>{l.accountCode} {l.accountName}</Link></td>
                <td>{l.description ?? ''}</td>
                <td className="num">{l.debit}</td>
                <td className="num">{l.credit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card" data-testid="journal-source">
        <h2>Source</h2>
        {!data.source ? <p className="muted">{data.sourceResolver}</p> : data.source.restricted ? (
          <p className="muted" role="status">This journal was posted from a {data.source.entityType.replace(/_/g, ' ')} you may not open ({data.source.requires}).</p>
        ) : (
          <>
            <p><strong>{data.source.entityType.replace(/_/g, ' ')}</strong> <code>{data.source.id}</code></p>
            <table>
              <tbody>
                {Object.entries(data.source).filter(([k]) => !HIDDEN.has(k)).map(([k, v]) => <tr key={k}><th>{k}</th><td>{v === null ? '' : String(v)}</td></tr>)}
              </tbody>
            </table>
            <h2>Attachments</h2>
            {(data.source.attachments ?? []).length === 0 ? <p className="muted">None.</p> : <ul>{data.source.attachments!.map((a, i) => <li key={i}>{String(a.kind ?? '')} {String(a.sourceType ?? '')} {String(a.sourceId ?? '')}</li>)}</ul>}
          </>
        )}
        {data.journalAttachments.length > 0 && <><h2>Attached to the journal</h2><ul>{data.journalAttachments.map((a, i) => <li key={i}>{String(a.kind ?? '')} {String(a.sourceId ?? '')}</li>)}</ul></>}
        {data.bankMatches.length > 0 && <><h2>Matched to the bank statement</h2><ul>{data.bankMatches.map((m) => <li key={m.id}>statement line {m.statementLineId}: {m.amount}</li>)}</ul></>}
      </div>
    </>
  );
}

export default function Page() { return <WorkspaceShell need="ledger:read"><JournalPage /></WorkspaceShell>; }
