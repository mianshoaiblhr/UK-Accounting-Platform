'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { PracticeShell } from '@/components/PracticeShell';
import { StatusPill, periodText, workName, type Obligation } from '@/components/compliance/common';
import { ApiError, api, errorText } from '@/lib/api';
import { showAmount } from '@/lib/format';

/**
 * V7-M2 (DEC-089): the practice overview of the prototype (DEC-079). The counts, the deadlines due soon and the open work are the API's, over the
 * clients the person may read; nothing is counted here. UI-2 (DEC-103): the date, "Add client" and the work by stage, as in the approved design;
 * the connections say what is true everywhere: no live connection exists (DEC-082, DEC-086).
 */
interface Summary { overdue: number; dueNext14: number; waitingOnClient: number; ready: number }
interface Work { byStatus: Record<string, number>; byKind: Record<string, number>; total: number; byStage: Record<string, number> }
const STAGE_NAMES: [string, string][] = [['BOOKKEEPING', 'Bookkeeping'], ['ACCOUNTS_PREPARATION', 'Accounts preparation'], ['MANAGER_REVIEW', 'Manager review'],
  ['PARTNER_REVIEW', 'Partner review'], ['CLIENT_APPROVAL', 'Client approval'], ['READY_TO_FILE', 'Ready to file']];
const today = () => new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' }).format(new Date()).replace(',', '');

function Overview() {
  const { orgId } = useParams<{ orgId: string }>();
  const [data, setData] = useState<{ summary: Summary; soon: Obligation[]; work: Work; mayAdd: boolean }>();
  const [error, setError] = useState<{ text: string; off: boolean }>();
  const load = useCallback(async () => {
    try {
      const [summary, soon, work, me] = await Promise.all([
        api<Summary>(`/organisations/${orgId}/compliance/summary`),
        api<{ items: Obligation[] }>(`/organisations/${orgId}/compliance/obligations?due=soon&limit=10`),
        api<Work>(`/organisations/${orgId}/compliance/work`),
        api<{ permissions: string[] }>(`/organisations/${orgId}/me`),
      ]);
      setData({ summary, soon: soon.items, work, mayAdd: me.permissions.includes('company:create') });
    } catch (e) { setError({ text: errorText(e), off: e instanceof ApiError && e.code === 'feature_disabled' }); }
  }, [orgId]);
  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <div className="page-head">
        <div><h1>Practice overview</h1><p className="muted" data-testid="today">{today()}</p></div>
        {data?.mayAdd && <Link className="button" href="/#add-company">Add client</Link>}
      </div>
      {error && (error.off ? (
        <div className="card" role="status" data-testid="feature-off">
          <h2>Practice management is not enabled</h2>
          <p>These screens are not enabled for this organisation yet. An owner can turn on the &quot;practice.management&quot; feature.</p>
        </div>
      ) : <p className="error" role="alert">{error.text}</p>)}
      {data && (
        <>
          <div className="tiles" data-testid="deadline-counts">
            <div className="card"><span>Overdue</span><strong className={data.summary.overdue ? 'alert' : undefined} data-testid="count-overdue">{data.summary.overdue}</strong></div>
            <div className="card"><span>Due in the next 14 days</span><strong data-testid="count-next14">{data.summary.dueNext14}</strong></div>
            <div className="card"><span>Waiting on the client</span><strong data-testid="count-waiting">{data.summary.waitingOnClient}</strong></div>
            <div className="card"><span>Ready to submit</span><strong data-testid="count-ready">{data.summary.ready}</strong></div>
          </div>
          <div className="split">
            <div className="card">
              <h2>Deadlines</h2>
              <p className="muted">Overdue and due in the next 14 days. <Link href={`/org/${orgId}/deadlines`}>All deadlines</Link></p>
              {data.soon.length === 0 ? <p className="muted">Nothing due soon.</p> : (
                <table data-testid="overview-deadlines">
                  <thead><tr><th>Client</th><th>Work</th><th>Period</th><th>Due</th><th>Status</th></tr></thead>
                  <tbody>{data.soon.map((o) => (
                    <tr key={o.id}><td><Link href={`/org/${orgId}/companies/${o.companyId}/compliance`}>{o.companyName}</Link></td><td>{workName(o)}</td><td>{periodText(o)}</td><td>{o.dueDate}</td><td><StatusPill o={o} /></td></tr>
                  ))}</tbody>
                </table>
              )}
            </div>
            <div>
              <div className="card">
                <h2>Work in progress</h2>
                <table data-testid="work-by-stage">
                  <tbody>{STAGE_NAMES.map(([k, l]) => (
                    <tr key={k}><td>{l}</td><td className="num">{showAmount(data.work.byStage[k] ?? 0)}</td></tr>
                  ))}</tbody>
                </table>
              </div>
              <div className="card" data-testid="connections">
                <h2>Connections</h2>
                <p><strong>HMRC</strong><br /><span className="muted">No live connection. VAT and Corporation Tax returns filed elsewhere are recorded here; where a test stand-in is set up, nothing reaches HMRC.</span></p>
                <p><strong>Companies House</strong><br /><span className="muted">No live connection. Accounts filed elsewhere are recorded here; where a test stand-in is set up, nothing reaches Companies House.</span></p>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

export default function Page() { return <PracticeShell>{() => <Overview />}</PracticeShell>; }
