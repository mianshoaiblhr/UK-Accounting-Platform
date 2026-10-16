'use client';
import { TransfersPage } from '@/components/bank/TransfersPage';
import { WorkspaceShell } from '@/lib/workspace';

export default function Page() { return <WorkspaceShell need="bank:read"><TransfersPage /></WorkspaceShell>; }
