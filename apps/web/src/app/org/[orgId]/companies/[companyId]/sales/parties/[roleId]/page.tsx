'use client';
import { StatementPage } from '@/components/subledger/StatementPage';
import { SIDES } from '@/components/subledger/side';
import { WorkspaceShell } from '@/lib/workspace';

export default function Page() { return <WorkspaceShell need={'sales:read'}><StatementPage side={SIDES.sales} /></WorkspaceShell>; }
