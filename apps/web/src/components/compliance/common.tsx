'use client';

/** V7-M1 (DEC-088): an obligation as the API returns it. The screens show these fields; `overdue` is the API's, never worked out here. */
export interface Obligation {
  id: string; companyId: string; companyName?: string; kind: string; title: string | null; periodStart: string | null; periodEnd: string | null; dueDate: string;
  source: 'RULE' | 'MANUAL'; status: string; overdue: boolean; assigneeUserId: string | null; doneOn: string | null; doneReference: string | null;
  evidenceDocumentId: string | null; statusReason: string | null; version: number;
}

export const KIND_NAMES: Record<string, string> = {
  ACCOUNTS_FILING: 'Annual accounts to Companies House', CT_PAYMENT: 'Corporation Tax payment', CT_RETURN: 'Company Tax Return (CT600)',
  CONFIRMATION_STATEMENT: 'Confirmation statement', VAT_RETURN: 'VAT return', OTHER: 'Other deadline',
};
export const STATUS_NAMES: Record<string, string> = {
  NOT_STARTED: 'Not started', IN_PROGRESS: 'In progress', WAITING_ON_CLIENT: 'Waiting on the client', READY: 'Ready to submit', DONE: 'Done', NOT_REQUIRED: 'Not required',
};

export const workName = (o: Obligation) => o.title ?? KIND_NAMES[o.kind] ?? o.kind;
export const periodText = (o: Obligation) => o.periodStart && o.periodEnd ? `${o.periodStart} to ${o.periodEnd}` : o.periodEnd ?? '';

/** The status pill: red ink only for what is wrong (overdue), settled green for done (DEC-076). */
export function StatusPill({ o }: { o: Obligation }) {
  return (
    <span className="pills">
      <span className={`badge status-${o.status}`} data-testid="obligation-status">{STATUS_NAMES[o.status] ?? o.status}</span>
      {o.overdue && <span className="badge HIGH" data-testid="obligation-overdue">Overdue</span>}
    </span>
  );
}
