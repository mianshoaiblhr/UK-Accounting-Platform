'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Nav } from '@/components/Nav';
import { StatusPill, periodText, workName, type Obligation } from '@/components/compliance/common';
import { ApiError, api, errorText, type Me } from '@/lib/api';

/**
 * V7-M1 (DEC-088): the practice's deadlines across the clients the person may read. The counts and the list are the API's, filtered by the
 * person's compliance:read on each client; nothing is counted or worked out here. The layout follows the prototype's overview (DEC-079).
 */
interface Summary { today: string; overdue: number; dueNext14: number; waitingOnClient: number; ready: number }
interface Page { today: string; items: Obligation[]; nextCursor: string | null }
const WINDOWS: [string, string][] = [['soon', 'Overdue and next 14 days'], ['next90', 'Next 90 days'], ['open', 'All open']];

export default function Deadlines() {
  const { orgId } = useParams<{ orgId: string }>();
  const router = useRouter();
  const [me, setMe] = useState<Me>();
  const [due, setDue] = useState('soon');
  const [summary, setSummary] = useState<Summary>();
  const [page, setPage] = useState<Page>();
  const [error, setError] = useState<{ text: string; off: boolean }>();

  useEffect(() => {
    api<Me>('/auth/me').then(setMe).catch((e) => { if (e instanceof ApiError && e.status === 401) router.push('/login'); });
  }, [router]);
  const load = useCallback(async () => {
    setError(undefined);
    try {
      const [s, p] = await Promise.all([
        api<Summary>(`/organisations/${orgId}/compliance/summary`),
        api<Page>(`/organisations/${orgId}/compliance/obligations?due=${due}&limit=200`),
      ]);
      setSummary(s); setPage(p);
    } catch (e) { setError({ text: errorText(e), off: e instanceof ApiError && e.code === 'feature_disabled' }); }
  }, [orgId, due]);
  useEffect(() => { void load(); }, [load]);

  if (!me) return <main><p>Loading…</p></main>;
  return (
    <>
      <Nav me={me} />
      <main className="wide">
        <h1>Deadlines</h1>
        {error && (error.off ? (
          <div className="card" role="status" data-testid="feature-off">
            <h2>Practice management is not enabled</h2>
            <p>These screens are not enabled for this organisation yet. An owner can turn on the &quot;practice.management&quot; feature.</p>
          </div>
        ) : <p className="error" role="alert">{error.text}</p>)}
        {summary && (
          <div className="tiles" data-testid="deadline-counts">
            <div className="card"><span>Overdue</span><strong className={summary.overdue ? 'alert' : undefined} data-testid="count-overdue">{summary.overdue}</strong></div>
            <div className="card"><span>Due in the next 14 days</span><strong data-testid="count-next14">{summary.dueNext14}</strong></div>
            <div className="card"><span>Waiting on the client</span><strong data-testid="count-waiting">{summary.waitingOnClient}</strong></div>
            <div className="card"><span>Ready to submit</span><strong data-testid="count-ready">{summary.ready}</strong></div>
          </div>
        )}
        {page && (
          <div className="card">
            <nav className="subnav" aria-label="Which deadlines">
              {WINDOWS.map(([v, l]) => v === due ? <span key={v} aria-current="page">{l}</span> : <a key={v} href="#" onClick={(e) => { e.preventDefault(); setDue(v); }}>{l}</a>)}
            </nav>
            {page.items.length === 0 ? <p className="muted">Nothing due in this window.</p> : (
              <table data-testid="practice-deadlines">
                <thead><tr><th>Client</th><th>Work</th><th>Period</th><th>Due</th><th>Status</th></tr></thead>
                <tbody>{page.items.map((o) => (
                  <tr key={o.id} data-obligation={o.id}>
                    <td><Link href={`/org/${orgId}/companies/${o.companyId}/compliance`}>{o.companyName}</Link></td>
                    <td>{workName(o)}</td>
                    <td>{periodText(o)}</td>
                    <td>{o.dueDate}</td>
                    <td><StatusPill o={o} /></td>
                  </tr>
                ))}</tbody>
              </table>
            )}
            {page.nextCursor && <p className="muted">Showing the first 200; narrow the window to see the rest.</p>}
          </div>
        )}
      </main>
    </>
  );
}
