'use client';

/**
 * V5-M3 (DEC-092): a VAT return, its flags, events and filings as the API returns them (DEC-090, DEC-091). The screens show these fields;
 * the status, the fingerprint, the flags, the box amounts and whether a step lapsed are the API's, never worked out here.
 */
export interface BoxLine { journalId: string; journalNumber: number; lineNo: number; accountCode: string; taxCode: string; taxPoint: string; amount: string }
export interface Box { box: number; amount: string; lines: BoxLine[]; direction?: 'PAYABLE' | 'REPAYABLE' }
export interface Explained { journalId: string; journalNumber: number; lineNo: number; journalDate: string; taxPoint: string | null; amount: string; reason: string }
export interface Workpaper {
  from: string; to: string; currency: string; vrn: string | null; scheme: string; boxes: Box[];
  reconciliation: { vatAccountMovement: string; vatLinesByTaxPoint: string; difference: string; explainedBy: Explained[] };
}
export interface Flag { key: string; kind: string; message: string; explanation: { note: string; byUserId: string; at: string } | null }
export interface ReturnEvent {
  id: string; kind: 'PREPARED' | 'FLAG_EXPLAINED' | 'REVIEWED' | 'CLIENT_APPROVED'; fingerprint: string; live: boolean; flagKey: string | null; note: string | null;
  byUserId: string; byName: string | null; at: string; approverContactId: string | null; approvedOn: string | null; evidenceDocumentId: string | null;
}
export interface VatReturn {
  id: string; companyId: string; periodFrom: string; periodTo: string; obligationId: string | null; status: string; fingerprint: string; locked: boolean; lockedAt: string | null;
  workpaper: Workpaper; flags: Flag[]; unexplainedFlags: number; events: ReturnEvent[]; notice: string;
}
export interface ReturnSummary { id: string; periodFrom: string; periodTo: string; status: string; locked: boolean; unexplainedFlags: number; obligationId: string | null }
export interface Filing {
  id: string; mode: 'RECORDED' | 'SIMULATED'; submittedOn: string; receiptReference: string; adapter: string | null; evidenceDocumentId: string | null; journalId: string | null;
  note: string | null; package: { boxes: Record<string, string>; box5Direction: string; presentation: { method: string } }; packageSha256: string; at: string; notice: string;
}

/** The box descriptions, as on HMRC's return and the prototype (DEC-079). */
export const BOX_NAMES: Record<number, string> = {
  1: 'VAT due on sales and other outputs',
  2: 'VAT due on acquisitions of goods made in Northern Ireland from EU member states',
  3: 'Total VAT due',
  4: 'VAT reclaimed on purchases and other inputs, including acquisitions in Northern Ireland from EU member states',
  5: 'Net VAT to pay to HMRC or reclaim',
  6: 'Total value of sales and all other outputs, excluding VAT',
  7: 'Total value of purchases and all other inputs, excluding VAT',
  8: 'Total value of dispatches of goods and related costs from Northern Ireland to EU member states, excluding VAT',
  9: 'Total value of acquisitions of goods and related costs made in Northern Ireland from EU member states, excluding VAT',
};
export const RETURN_STATUS_NAMES: Record<string, string> = { DRAFT: 'Draft', PREPARED: 'Prepared', REVIEWED: 'Reviewed', APPROVED: 'Approved by the client' };
export const EVENT_NAMES: Record<string, string> = { PREPARED: 'Prepared', FLAG_EXPLAINED: 'Flag explained', REVIEWED: 'Reviewed', CLIENT_APPROVED: 'Approved by the client' };

/** The status as the API states it: settled green once approved (DEC-076). */
export function ReturnStatus({ status }: { status: string }) {
  return <span className={`badge status-${status === 'APPROVED' ? 'DONE' : status === 'REVIEWED' ? 'READY' : status}`} data-testid="return-status">{RETURN_STATUS_NAMES[status] ?? status}</span>;
}
