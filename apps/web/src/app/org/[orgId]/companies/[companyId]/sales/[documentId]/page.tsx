'use client';
import { DocumentPage } from '@/components/subledger/DocumentPage';
import { SIDES } from '@/components/subledger/side';
import { WorkspaceShell } from '@/lib/workspace';

export default function Page() { return <WorkspaceShell need={'sales:read'}><DocumentPage side={SIDES.sales} /></WorkspaceShell>; }
