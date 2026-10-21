import { z } from 'zod';

/**
 * V2-M6c (DEC-070): partner review, client approval, locking and the filing-ready package. The fingerprint of the accounts document ties the
 * three records together: a partner review is live while the accounts are unchanged; the client approval needs a live review of the same
 * accounts and locks the year; the package holds the accounts as approved and is refused unless every rule it uses was verified by a second
 * person (V2-ARC-04).
 */
export const APPROVAL_STAGES = ['PARTNER_REVIEW', 'CLIENT_APPROVAL'] as const;
export const PACKAGE_FORMAT = 'uk-accounts-package/1';

/** JSON with every object's keys sorted, so the same value always gives the same text (the fingerprint's input). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/**
 * Why an approval date is not acceptable (DEC-070): after the year end and not in the future. Dates are YYYY-MM-DD. It is not compared with
 * the partner review's date: an approval that happened before the accounts reached the platform is recorded with both dates.
 */
export function approvalDateProblems(a: { yearEnd: string; approvedOn: string; today: string }): string[] {
  const out: string[] = [];
  if (a.approvedOn <= a.yearEnd) out.push(`accounts are approved after the year end (${a.yearEnd})`);
  if (a.approvedOn > a.today) out.push('an approval is recorded once it has happened, not before');
  return out;
}

/** What stops the filing-ready package (DEC-070, V2-ARC-04); empty when it may be generated. */
export function packageProblems(a: { approved: boolean; fingerprint: string | null; approvedFingerprint: string | null; documentComplete: boolean; versionVerified: boolean;
  thresholdSetsVerified: boolean; sizeFits: boolean | null }): string[] {
  const out: string[] = [];
  if (!a.approved) out.push("the client's approval is not recorded");
  else if (a.fingerprint !== a.approvedFingerprint) out.push('the accounts changed since they were approved');
  if (!a.documentComplete) out.push('the accounts document is not complete');
  if (!a.versionVerified) out.push('the standard version was not verified by a second person');
  if (!a.thresholdSetsVerified) out.push('the size test uses a threshold set not verified by a second person, or none');
  if (a.sizeFits !== true) out.push('the chosen entity size does not fit');
  return out;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'Invalid date');
const note = z.string().trim().min(3).max(2000);
export const accountsApprovalQuerySchema = z.object({ yearStart: isoDate }).strict();
export const partnerReviewSchema = z.object({ yearStart: isoDate, note: note.optional() }).strict();
export const clientApprovalSchema = z.object({ yearStart: isoDate, directorContactId: z.string().uuid(), approvedOn: isoDate, evidenceDocumentId: z.string().uuid(), note: note.optional() }).strict();
export const generatePackageSchema = z.object({ yearStart: isoDate }).strict();
