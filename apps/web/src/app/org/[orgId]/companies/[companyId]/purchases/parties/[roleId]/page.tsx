'use client';
import { StatementPage } from '@/components/subledger/StatementPage';
import { SIDES } from '@/components/subledger/side';
import { WorkspaceShell } from '@/lib/workspace';

export default function Page() { return <WorkspaceShell need={'purchases:read'}><StatementPage side={SIDES.purchases} /></WorkspaceShell>; }
