'use client';
import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Nav } from '@/components/Nav';
import { ApiError, api, errorText, type Company, type CompanyAccess, type Me } from '@/lib/api';

/**
 * The company workspace (M9a, DEC-048/049). It loads who the person is, the company and what they may do there (`my-access`), and shows only the
 * sections they may read. With `bookkeeping.core` off it says so and calls no gated route. The API stays the only enforcement.
 */
interface Workspace { me: Me; orgId: string; company: Company; access: CompanyAccess; can: (permission: string) => boolean; base: string; path: (p: string) => string }
const Ctx = createContext<Workspace | null>(null);
export const useWorkspace = () => {
  const w = useContext(Ctx);
  if (!w) throw new Error('useWorkspace outside the workspace');
  return w;
};

const SECTIONS: { href: string; label: string; permission: string; feature?: string }[] = [
  { href: '', label: 'Dashboard', permission: 'ledger:read' },
  { href: '/accounts', label: 'Accounts', permission: 'account:read' },
  { href: '/journals', label: 'Journals', permission: 'ledger:read' },
  { href: '/trial-balance', label: 'Trial balance', permission: 'ledger:read' },
  { href: '/reports/profit-and-loss', label: 'Profit and loss', permission: 'ledger:read' },
  { href: '/reports/balance-sheet', label: 'Balance sheet', permission: 'ledger:read' },
  { href: '/periods', label: 'Periods', permission: 'period:read' },
  { href: '/sales', label: 'Sales', permission: 'sales:read' },
  { href: '/purchases', label: 'Purchases', permission: 'purchases:read' },
  { href: '/bank', label: 'Bank', permission: 'bank:read' },
  { href: '/cash', label: 'Cash', permission: 'cash:read' },
  // V2-M7 (DEC-071): accounts production, shown only while its feature is on
  { href: '/year-end', label: 'Year end', permission: 'ledger:read', feature: 'accounts.production' },
  { href: '/registers', label: 'Registers', permission: 'ledger:read', feature: 'accounts.production' },
];

/** `feature`: a further feature the page needs besides bookkeeping (V2 screens: `accounts.production`); while it is off the page says so and renders nothing that calls the API. */
export function WorkspaceShell({ children, need, feature }: { children: ReactNode; need?: string; feature?: string }) {
  const { orgId, companyId } = useParams<{ orgId: string; companyId: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<{ me: Me; company: Company; access: CompanyAccess } | { error: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const me = await api<Me>('/auth/me');
        const [company, access] = await Promise.all([
          api<Company>(`/organisations/${orgId}/companies/${companyId}`),
          api<CompanyAccess>(`/organisations/${orgId}/companies/${companyId}/my-access`),
        ]);
        setState({ me, company, access });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) router.push('/login');
        else setState({ error: errorText(e) });
      }
    })();
  }, [orgId, companyId, router]);

  if (!state) return <main><p>Loading…</p></main>;
  if ('error' in state) return <main><p className="error" role="alert">{state.error}</p></main>;
  const base = `/org/${orgId}/companies/${companyId}`;
  const can = (p: string) => state.access.permissions.includes(p);
  const enabled = state.access.features['bookkeeping.core'] === true;
  const w: Workspace = { ...state, orgId, can, base, path: (p) => `/organisations/${orgId}/companies/${companyId}${p}` };
  return (
    <Ctx.Provider value={w}>
      <Nav me={state.me} />
      <main className="wide">
        <p className="muted"><Link href="/">Companies</Link> / <strong>{state.company.name}</strong> <span className="muted">({state.company.baseCurrency})</span></p>
        {!enabled ? (
          <div className="card" role="status" data-testid="feature-off">
            <h1>Bookkeeping is not enabled</h1>
            <p>The bookkeeping screens are not enabled for this organisation yet. An owner can turn on the &quot;bookkeeping.core&quot; feature.</p>
          </div>
        ) : (
          <>
            <nav className="tabs" aria-label="Bookkeeping">
              {SECTIONS.filter((s) => can(s.permission) && (!s.feature || state.access.features[s.feature] === true)).map((s) => (
                <Link key={s.href} href={`${base}${s.href}`} aria-current={pathname === `${base}${s.href}` || (s.href !== '' && ['/year-end', '/registers'].includes(s.href) && pathname.startsWith(`${base}${s.href}`)) ? 'page' : undefined}>{s.label}</Link>
              ))}
            </nav>
            {feature && state.access.features[feature] !== true ? (
              <div className="card" role="status" data-testid="feature-off">
                <h1>Accounts production is not enabled</h1>
                <p>These screens are not enabled for this organisation yet. An owner can turn on the &quot;{feature}&quot; feature.</p>
              </div>
            ) : need && !can(need) ? <div className="card"><p className="muted" role="status">You do not have access to this section ({need}).</p></div> : children}
          </>
        )}
      </main>
    </Ctx.Provider>
  );
}

/** Loads one API resource for a screen, with its error shown as the API words it. `reload` re-fetches after an action. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  // only the latest request may set what the screen shows: a slower answer for an earlier path (a date being changed) is dropped, never shown
  const latest = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const call = ++latest.current;
    setError('');
    try { const d = await api<T>(path); if (call === latest.current) setData(d); } catch (e) { if (call === latest.current) setError(errorText(e)); }
  }, [path]);
  useEffect(() => { void load(); }, [load]);
  return { data, error, reload: load };
}

export const qs = (o: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** Money as the API returned it, right-aligned; never re-computed here (DEC-048). */
export const Money = ({ v }: { v: string | null | undefined }) => <td className="num">{v ?? ''}</td>;
