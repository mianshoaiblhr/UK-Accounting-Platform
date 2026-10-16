'use client';
import { Reconcile } from '@/components/bank/Reconcile';
import { WorkspaceShell } from '@/lib/workspace';

export default function Page() { return <WorkspaceShell need="bank:read"><Reconcile /></WorkspaceShell>; }
