import { createHash } from 'node:crypto';

/**
 * The HMRC VAT port (V5-M2, DEC-091). The platform has no HMRC connection (DEC-082, DEC-086): the only adapter is `fake`, which returns a
 * receipt marked FAKE so the filing path can be exercised end to end. A real adapter (OAuth, fraud-prevention headers, the obligations and
 * returns endpoints) is a later decision. Production refuses the fake adapter at start (packages/core/src/config.ts).
 */
export interface VatSubmission {
  vrn: string;
  periodFrom: string;
  periodTo: string;
  /** Boxes 1 to 5 in pounds and pence; boxes 6 to 9 in whole pounds (already presented by the verified rule). */
  boxes: Record<'1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9', string>;
  finalised: true;
}
export interface VatReceipt { fake: boolean; processingDate: string; formBundleNumber: string; chargeRefNumber: string | null; paymentIndicator: 'DD' | 'BANK' | null }
export interface HmrcVatPort { readonly name: string; submitReturn(s: VatSubmission): Promise<VatReceipt> }

export class FakeHmrcVatAdapter implements HmrcVatPort {
  readonly name = 'fake';
  async submitReturn(s: VatSubmission): Promise<VatReceipt> {
    // deterministic for the same submission, and plainly not an HMRC number (it starts 000)
    const digits = BigInt(`0x${createHash('sha256').update(JSON.stringify(s)).digest('hex').slice(0, 12)}`).toString().padStart(9, '0').slice(-9);
    return { fake: true, processingDate: new Date().toISOString(), formBundleNumber: `000${digits}`, chargeRefNumber: null, paymentIndicator: null };
  }
}
