'use client';
import Link from 'next/link';
import { useWorkspace } from '@/lib/workspace';
import type { Side } from './side';

export function SideNav({ side }: { side: Side }) {
  const w = useWorkspace();
  const b = `${w.base}/${side.key}`;
  return (
    <p className="muted" data-testid="side-nav">
      <Link href={b}>Documents</Link>{' · '}
      {w.can(side.manage) && <><Link href={`${b}/new`}>New {side.doc.label.toLowerCase()}</Link>{' · '}</>}
      <Link href={`${b}/money`}>{side.money.plural}</Link>{' · '}
      <Link href={`${b}/ageing`}>{side.aged.label}</Link>
    </p>
  );
}
