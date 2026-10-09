import { z } from 'zod';

/**
 * Document types (specification §6 "document type"). Mirrors the seed of the `document_type` reference table; tests keep both identical.
 * Later versions append codes here AND in a migration. `FILING_EVIDENCE` is the type used for submitted returns and receipts.
 */
export const DOCUMENT_TYPES = [
  { code: 'GENERAL', name: 'General document' },
  { code: 'BANK_STATEMENT', name: 'Bank statement' },
  { code: 'SALES_INVOICE', name: 'Sales invoice' },
  { code: 'PURCHASE_INVOICE', name: 'Purchase invoice' },
  { code: 'CREDIT_NOTE', name: 'Credit note' },
  { code: 'RECEIPT', name: 'Receipt' },
  { code: 'CONTRACT', name: 'Contract or agreement' },
  { code: 'LETTER_OF_ENGAGEMENT', name: 'Letter of engagement' },
  { code: 'PAYROLL_RECORD', name: 'Payroll record' },
  { code: 'VAT_WORKING', name: 'VAT working' },
  { code: 'TAX_CORRESPONDENCE', name: 'Tax correspondence' },
  { code: 'STATUTORY_ACCOUNTS', name: 'Statutory accounts' },
  { code: 'FILING_EVIDENCE', name: 'Filing evidence' },
  { code: 'IDENTITY_VERIFICATION', name: 'Identity verification' },
  { code: 'MINUTES', name: 'Minutes or resolution' },
  { code: 'OTHER', name: 'Other' },
] as const;
export type DocumentTypeCode = (typeof DOCUMENT_TYPES)[number]['code'];
export const isDocumentType = (c: string): c is DocumentTypeCode => DOCUMENT_TYPES.some((t) => t.code === c);

export const DOCUMENT_VISIBILITY = ['STANDARD', 'RESTRICTED'] as const;
export type DocumentVisibility = (typeof DOCUMENT_VISIBILITY)[number];

/** Filing evidence is kept at least this long unless the caller sets a later date (UK company records: six years). */
export const EVIDENCE_DEFAULT_RETENTION_YEARS = 6;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date');
const labels = z.array(z.string().trim().min(1).max(40)).max(10).transform((a) => [...new Set(a)]);

/** Type-specific attributes: scalar values only, bounded in count and size (no nested documents, no blobs). */
export const documentMetadataSchema = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/), z.union([z.string().max(500), z.number().finite(), z.boolean()]))
  .refine((m) => Object.keys(m).length <= 20, 'At most 20 metadata keys')
  .refine((m) => JSON.stringify(m).length <= 8192, 'Metadata is limited to 8 KB');

export const documentFieldsSchema = {
  documentClass: z.string().max(60),
  folderId: z.string().uuid(),
  periodId: z.string().uuid(),
  description: z.string().trim().max(2000),
  documentDate: isoDate,
  reference: z.string().trim().min(1).max(120),
  labels,
  metadata: documentMetadataSchema,
  visibility: z.enum(DOCUMENT_VISIBILITY),
};

export const updateDocumentSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  documentClass: documentFieldsSchema.documentClass.optional(),
  folderId: documentFieldsSchema.folderId.nullable().optional(),
  periodId: documentFieldsSchema.periodId.nullable().optional(),
  description: documentFieldsSchema.description.nullable().optional(),
  documentDate: documentFieldsSchema.documentDate.nullable().optional(),
  reference: documentFieldsSchema.reference.nullable().optional(),
  labels: documentFieldsSchema.labels.optional(),
  metadata: documentFieldsSchema.metadata.optional(),
  visibility: documentFieldsSchema.visibility.optional(),
  reason: z.string().trim().min(1).max(1000).optional(),
}).strict().refine((b) => Object.keys(b).some((k) => k !== 'reason'), 'Nothing to update');

export const documentListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().optional(),
  companyId: z.string().uuid().optional(), folderId: z.string().uuid().optional(), periodId: z.string().uuid().optional(),
  documentClass: z.string().max(60).optional(), visibility: z.enum(DOCUMENT_VISIBILITY).optional(),
  q: z.string().trim().min(1).max(100).optional(), status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  evidenceLocked: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});

export const createFolderSchema = z.object({
  name: z.string().trim().min(1).max(120).refine((n) => !/[\\/]/.test(n), 'A folder name cannot contain / or \\'),
  companyId: z.string().uuid().optional(), parentId: z.string().uuid().optional(),
}).strict();
export const updateFolderSchema = z.object({
  name: z.string().trim().min(1).max(120).refine((n) => !/[\\/]/.test(n), 'A folder name cannot contain / or \\').optional(),
  parentId: z.string().uuid().nullable().optional(),
}).strict().refine((b) => b.name !== undefined || b.parentId !== undefined, 'Nothing to update');
export const folderListQuerySchema = z.object({ companyId: z.string().uuid().optional(), parentId: z.string().uuid().optional() });

export const grantDocumentAccessSchema = z.object({ userId: z.string().uuid() }).strict();
export const evidenceLockSchema = z.object({
  versionId: z.string().uuid(), reason: z.string().trim().min(1).max(1000), retainUntil: isoDate.optional(),
}).strict();

// ───────── evidence graph (cross-platform §6) ─────────
/** Entities that can be linked. Later versions append (journal, bank_transaction, report, tax_return, filing ...) together with a resolver. */
export const EVIDENCE_ENTITY_TYPES = ['document', 'document_version', 'task', 'workflow_instance', 'ai_proposal', 'contact', 'company', 'accounting_period', 'journal'] as const;
export type EvidenceEntityType = (typeof EVIDENCE_ENTITY_TYPES)[number];
export const EVIDENCE_KINDS = ['SUPPORTS', 'DERIVED_FROM', 'ATTACHED_TO', 'REFERENCES', 'FILED_AS'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const createEvidenceLinkSchema = z.object({
  sourceType: z.enum(EVIDENCE_ENTITY_TYPES), sourceId: z.string().uuid(),
  targetType: z.enum(EVIDENCE_ENTITY_TYPES), targetId: z.string().uuid(),
  kind: z.enum(EVIDENCE_KINDS), note: z.string().trim().min(1).max(500).optional(),
}).strict();
export const evidenceLinkQuerySchema = z.object({
  entityType: z.enum(EVIDENCE_ENTITY_TYPES), entityId: z.string().uuid(),
  direction: z.enum(['out', 'in', 'both']).default('both'), includeRevoked: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export const revokeEvidenceLinkSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
