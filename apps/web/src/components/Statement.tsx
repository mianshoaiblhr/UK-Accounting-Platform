'use client';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { qs } from '@/lib/workspace';

export interface ReportLine { key: string; name: string; amount: string; comparative?: string; total?: boolean; accounts?: { accountId: string; code: string; name: string; amount: string; drilldown: { accountId: string; from: string | null; to: string; excludeClosing?: boolean } }[] }

/** A financial statement exactly as the API returned it (DEC-048): lines, totals and comparatives; each line opens its accounts, each account its ledger. */
export function Statement({ lines, base, currency, compareLabel, label }: { lines: ReportLine[]; base: string; currency: string; label: string; compareLabel?: string | null }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <table data-testid="statement">
      <thead><tr><th>{currency}</th><th className="num">{label}</th>{compareLabel ? <th className="num">{compareLabel}</th> : null}</tr></thead>
      <tbody>
        {lines.map((l) => (
          <Fragment key={l.key}>
            <tr className={l.total ? 'total' : undefined} data-key={l.key}>
              <td>{l.accounts?.length ? <button className="secondary disclose" aria-expanded={!!open[l.key]} onClick={() => setOpen({ ...open, [l.key]: !open[l.key] })}>{open[l.key] ? '−' : '+'}</button> : null} {l.name}</td>
              <td className="num">{l.amount}</td>
              {compareLabel ? <td className="num">{l.comparative ?? ''}</td> : null}
            </tr>
            {open[l.key] && l.accounts?.map((a) => (
              <tr key={`${l.key}-${a.accountId}`}>
                <td className="indent"><Link href={`${base}/ledger${qs({ accountId: a.accountId, from: a.drilldown.from ?? undefined, to: a.drilldown.to, excludeClosing: a.drilldown.excludeClosing ? 'true' : undefined })}`}>{a.code} {a.name}</Link></td>
                <td className="num">{a.amount}</td>
                {compareLabel ? <td /> : null}
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}
