/**
 * Sales and purchases mirror each other in the API (DEC-033): one set of screens, configured per side (M9b, plan 13.2).
 * Every path here is relative to /organisations/{org}/companies/{company}.
 */
export type SideKey = 'sales' | 'purchases';
export interface Side {
  key: SideKey; label: string; read: string; manage: string; approve: string;
  role: 'CUSTOMER' | 'SUPPLIER'; party: string; partyField: 'customerRoleId' | 'supplierRoleId';
  doc: { kind: 'INVOICE' | 'BILL'; label: string; create: string };
  note: { kind: 'CREDIT_NOTE' | 'DEBIT_NOTE'; label: string; create: string; original: 'originalInvoiceId' | 'originalBillId' };
  money: { label: string; plural: string; path: string; date: 'receiptDate' | 'paymentDate'; allocate: 'invoiceId' | 'billId' };
  documents: string; aged: { path: string; label: string; rows: 'customers' | 'suppliers'; unallocated: 'unallocatedCredits' | 'unallocatedDebits' };
  statement: (roleId: string) => string;
  lineAccountTypes: string[]; vatDirection: 'SALES' | 'PURCHASES'; supplierReference: boolean; partyDefaultVat: boolean;
  approveFields: Record<string, string>;
}

export const SIDES: Record<SideKey, Side> = {
  sales: {
    key: 'sales', label: 'Sales', read: 'sales:read', manage: 'sales:manage', approve: 'sales:approve',
    role: 'CUSTOMER', party: 'Customer', partyField: 'customerRoleId',
    doc: { kind: 'INVOICE', label: 'Invoice', create: '/sales/invoices' },
    note: { kind: 'CREDIT_NOTE', label: 'Credit note', create: '/sales/credit-notes', original: 'originalInvoiceId' },
    money: { label: 'Receipt', plural: 'Receipts', path: '/sales/receipts', date: 'receiptDate', allocate: 'invoiceId' },
    documents: '/sales/documents', aged: { path: '/sales/aged-receivables', label: 'Aged receivables', rows: 'customers', unallocated: 'unallocatedCredits' },
    statement: (id) => `/sales/customers/${id}/statement`,
    lineAccountTypes: ['INCOME'], vatDirection: 'SALES', supplierReference: false, partyDefaultVat: true,
    approveFields: { possible_duplicate: 'duplicateOverrideReason', credit_limit_exceeded: 'creditLimitOverrideReason' },
  },
  purchases: {
    key: 'purchases', label: 'Purchases', read: 'purchases:read', manage: 'purchases:manage', approve: 'purchases:approve',
    role: 'SUPPLIER', party: 'Supplier', partyField: 'supplierRoleId',
    doc: { kind: 'BILL', label: 'Bill', create: '/purchases/bills' },
    note: { kind: 'DEBIT_NOTE', label: 'Debit note', create: '/purchases/debit-notes', original: 'originalBillId' },
    money: { label: 'Payment', plural: 'Payments', path: '/purchases/payments', date: 'paymentDate', allocate: 'billId' },
    documents: '/purchases/documents', aged: { path: '/purchases/aged-payables', label: 'Aged payables', rows: 'suppliers', unallocated: 'unallocatedDebits' },
    statement: (id) => `/purchases/suppliers/${id}/statement`,
    lineAccountTypes: ['EXPENSE', 'ASSET'], vatDirection: 'PURCHASES', supplierReference: true, partyDefaultVat: false,
    approveFields: { possible_duplicate: 'duplicateOverrideReason' },
  },
};

export interface Party { id: string; accountCode: string | null; status: string; contact: { name: string }; customer: { defaultTaxCodeId: string | null } | null }
export interface TaxCode { id: string; code: string; name: string; direction: 'SALES' | 'PURCHASES' | 'BOTH'; reverseCharge: boolean }
export interface Account { id: string; code: string; name: string; type: string; subtype: string; isControl: boolean }
export const partyName = (p: Party | undefined) => (p ? `${p.contact.name}${p.accountCode ? ` (${p.accountCode})` : ''}` : '');
