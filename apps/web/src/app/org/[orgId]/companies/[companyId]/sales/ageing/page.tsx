'use client';
import { AgedPage } from '@/components/subledger/AgedPage';
import { SIDES } from '@/components/subledger/side';
import { WorkspaceShell } from '@/lib/workspace';

export default function Page() { return <WorkspaceShell need={'sales:read'}><AgedPage side={SIDES.sales} /></WorkspaceShell>; }
