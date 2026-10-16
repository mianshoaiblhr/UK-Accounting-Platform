'use client';
import { DocumentList } from '@/components/subledger/DocumentList';
import { SIDES } from '@/components/subledger/side';
import { WorkspaceShell } from '@/lib/workspace';

export default function Page() { return <WorkspaceShell need={'sales:read'}><DocumentList side={SIDES.sales} /></WorkspaceShell>; }
