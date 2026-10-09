/** Declarative, versioned workflow definitions. Instances are persisted; transitions are append-only history. */
export interface WorkflowTransitionDef {
  action: string;
  from: string[];
  to: string;
  /** Permission the actor must hold in the organisation. */
  permission: string;
  /** Segregation of duties: actor must differ from whoever started the instance. */
  requireDifferentFromStarter?: boolean;
  /**
   * Segregation of duties: the actor must not have performed any of these actions earlier in this workflow instance
   * (in ANY attempt, so a reopen cannot be used to review one's own earlier work) (e.g. an approver cannot also have prepared or reviewed). Stricter workflows (accounts, statutory filings)
   * list more actions here.
   */
  requireDistinctFrom?: string[];
  commentRequired?: boolean;
  /** At least one evidence document must accompany the transition. */
  evidenceRequired?: boolean;
  /** May be taken from a terminal state (reopen after rejection); starts a new attempt. */
  retry?: boolean;
}

export interface WorkflowDefinition {
  type: string;
  version: number;
  initialState: string;
  terminalStates: string[];
  transitions: WorkflowTransitionDef[];
  /** May be started through the public API (otherwise only server modules start it). */
  apiStartable?: boolean;
  /** Permission needed to start through the API. */
  startPermission?: string;
  /** Optional service level: a new instance is due this many hours after it starts (unless the caller supplies a deadline). */
  slaHours?: number;
}

/**
 * Definitions are versioned: an instance keeps the version it started with, new instances use the latest.
 * Every definition declares explicit transitions; there is no way to change state without one (no silent transitions),
 * each transition names the permission it needs (evaluated for the instance's company) and is written to the
 * append-only history with actor, timestamp, comment and evidence.
 */
export const WORKFLOW_DEFINITIONS: WorkflowDefinition[] = [
  {
    // Generic maker/checker approval any later module can reuse.
    type: 'generic_approval', version: 1, initialState: 'DRAFT', terminalStates: ['APPROVED', 'REJECTED', 'CANCELLED'],
    apiStartable: true, startPermission: 'workflow:manage',
    transitions: [
      { action: 'submit', from: ['DRAFT'], to: 'SUBMITTED', permission: 'workflow:manage' },
      { action: 'approve', from: ['SUBMITTED'], to: 'APPROVED', permission: 'workflow:manage', requireDifferentFromStarter: true },
      { action: 'reject', from: ['SUBMITTED'], to: 'REJECTED', permission: 'workflow:manage', requireDifferentFromStarter: true, commentRequired: true },
      { action: 'cancel', from: ['DRAFT', 'SUBMITTED'], to: 'CANCELLED', permission: 'workflow:manage' },
    ],
  },
  {
    // The platform standard: prepare -> review -> approval, with rejection and an explicit retry path.
    // Accounting and statutory-filing workflows build on this shape and ADD controls (evidenceRequired,
    // requireDistinctFrom, commentRequired, stricter permissions); they never weaken it.
    type: 'standard_workflow', version: 1, initialState: 'DRAFT', terminalStates: ['COMPLETED', 'REJECTED'],
    apiStartable: true, startPermission: 'workflow:manage',
    transitions: [
      { action: 'begin', from: ['DRAFT'], to: 'IN_PROGRESS', permission: 'workflow:manage' },
      { action: 'submit_for_review', from: ['IN_PROGRESS'], to: 'REVIEW', permission: 'workflow:manage' },
      { action: 'request_changes', from: ['REVIEW'], to: 'IN_PROGRESS', permission: 'workflow:review', commentRequired: true, requireDistinctFrom: ['submit_for_review'] },
      { action: 'pass_review', from: ['REVIEW'], to: 'APPROVAL', permission: 'workflow:review', requireDistinctFrom: ['submit_for_review'] },
      { action: 'reject', from: ['REVIEW'], to: 'REJECTED', permission: 'workflow:review', commentRequired: true, requireDistinctFrom: ['submit_for_review'] },
      { action: 'approve', from: ['APPROVAL'], to: 'COMPLETED', permission: 'workflow:approve', requireDistinctFrom: ['submit_for_review', 'pass_review'] },
      { action: 'reject', from: ['APPROVAL'], to: 'REJECTED', permission: 'workflow:approve', commentRequired: true },
      { action: 'reopen', from: ['REJECTED'], to: 'DRAFT', permission: 'workflow:manage', commentRequired: true, retry: true },
    ],
  },
  {
    // v1 (legacy vocabulary). Kept so proposals created before the AI state-model change can still be decided.
    type: 'ai_proposal_review', version: 1, initialState: 'PENDING_REVIEW', terminalStates: ['APPROVED', 'REJECTED'],
    transitions: [
      { action: 'approve', from: ['PENDING_REVIEW'], to: 'APPROVED', permission: 'ai:approve' },
      { action: 'reject', from: ['PENDING_REVIEW'], to: 'REJECTED', permission: 'ai:approve', commentRequired: true },
    ],
  },
  {
    // v2: AI output is only ever a suggestion. A human must start a review and then explicitly accept or reject it;
    // nothing is applied by this workflow - an accepted suggestion still goes through the owning application service.
    type: 'ai_proposal_review', version: 2, initialState: 'SUGGESTED', terminalStates: ['ACCEPTED', 'REJECTED'],
    transitions: [
      { action: 'begin_review', from: ['SUGGESTED'], to: 'UNDER_REVIEW', permission: 'ai:approve' },
      { action: 'accept', from: ['UNDER_REVIEW'], to: 'ACCEPTED', permission: 'ai:approve' },
      { action: 'reject', from: ['SUGGESTED', 'UNDER_REVIEW'], to: 'REJECTED', permission: 'ai:approve', commentRequired: true },
    ],
  },
];
