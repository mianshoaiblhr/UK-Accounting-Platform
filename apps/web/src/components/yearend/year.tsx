'use client';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useApi, useWorkspace, qs } from '@/lib/workspace';

/**
 * V2-M7a (DEC-071): the year-end workspace's shared parts. The financial years come from the company's reporting frameworks; the chosen year
 * travels in the address (`?year=`), so every year-end screen opens on the same year. Nothing here computes a figure or a state.
 */
export interface Framework { id: string; yearStart: string; yearEnd: string; entitySize: string; lockedAt: string | null; version?: { label: string; status: string } }

/** The chosen year (from `?year=`, else the latest framework year), with the list to choose from. */
export function useYear() {
  const w = useWorkspace();
  const sp = useSearchParams();
  const { data, error } = useApi<{ items: Framework[] }>(w.path('/reporting-frameworks'));
  const items = data?.items ?? [];
  const asked = sp.get('year');
  const year = items.find((f) => f.yearStart === asked) ?? items.at(-1) ?? null;
  return { items, year, error, loaded: !!data };
}

const PAGES = [
  { href: '', label: 'Workflow' },
  { href: '/review', label: 'Review' },
  { href: '/accounts', label: 'Accounts' },
  { href: '/approval', label: 'Approval' },
];

/** The year chooser and the year-end sub-navigation. `locked`: the lock as the screen's own API answer has it, fresher than the year list after an approval. */
export function YearBar({ title, locked }: { title: string; locked?: boolean }) {
  const w = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const { items, year, error, loaded } = useYear();
  const base = `${w.base}/year-end`;
  return (
    <>
      <h1>{title}</h1>
      {error && <p className="error" role="alert">{error}</p>}
      {loaded && items.length === 0 && <p className="muted" role="status">No financial year has a reporting framework yet. A preparer chooses one for the year first.</p>}
      {year && (
        <div className="row" style={{ alignItems: 'center', gap: 12 }}>
          <label htmlFor="year-choice" style={{ margin: 0 }}>Financial year</label>
          <select id="year-choice" value={year.yearStart} style={{ width: 'auto' }} onChange={(e) => router.replace(`${pathname}${qs({ year: e.target.value })}`)}>
            {items.map((f) => <option key={f.id} value={f.yearStart}>{f.yearStart} to {f.yearEnd} ({f.entitySize}{f.lockedAt ? ', approved' : ''})</option>)}
          </select>
          {year.version && <span className="muted">{year.version.label} ({year.version.status})</span>}
          {(locked ?? !!year.lockedAt) && <span className="badge" data-testid="year-locked">Approved and locked</span>}
        </div>
      )}
      <p className="muted" data-testid="year-end-nav">
        {PAGES.map((p, i) => (
          <span key={p.href}>{i > 0 && ' · '}{pathname === `${base}${p.href}` ? <strong>{p.label}</strong> : <Link href={`${base}${p.href}${qs({ year: year?.yearStart })}`}>{p.label}</Link>}</span>
        ))}
      </p>
    </>
  );
}

/** The API's notices as it words them; a PREVIEW ONLY notice is shown as a warning (DEC-052). */
export function Notices({ notices }: { notices: string[] }) {
  if (!notices.length) return null;
  return (
    <ul data-testid="notices">
      {notices.map((n) => <li key={n} className={n.startsWith('PREVIEW ONLY') ? 'error' : 'muted'}>{n}</li>)}
    </ul>
  );
}

/** Figures as the API returned them, label by label; nothing is added up here. */
export function Figures({ figures }: { figures: Record<string, unknown> }) {
  return <span className="muted">{Object.entries(figures).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join('; ')}</span>;
}
