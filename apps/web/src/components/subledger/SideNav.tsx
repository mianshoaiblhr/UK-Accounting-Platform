'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useWorkspace } from '@/lib/workspace';
import type { Side } from './side';

export function SideNav({ side }: { side: Side }) {
  const w = useWorkspace();
  const b = `${w.base}/${side.key}`;
  const pathname = usePathname();
  const at = (href: string) => (pathname === href ? 'page' : undefined);
  return (
    <nav className="subnav" aria-label={side.doc.label} data-testid="side-nav">
      <Link href={b} aria-current={at(b)}>Documents</Link>
      {w.can(side.manage) && <Link href={`${b}/new`} aria-current={at(`${b}/new`)}>New {side.doc.label.toLowerCase()}</Link>}
      <Link href={`${b}/money`} aria-current={at(`${b}/money`)}>{side.money.plural}</Link>
      <Link href={`${b}/ageing`} aria-current={at(`${b}/ageing`)}>{side.aged.label}</Link>
    </nav>
  );
}
