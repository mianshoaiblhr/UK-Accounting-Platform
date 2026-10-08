/** Declarative, versioned workflow definitions. Instances are persisted; transitions are append-only history. */
export interface WorkflowTransitionDef {
  action: string;
  from: string[];
  to: string;
  /** Permission the actor must hold in the organisation. */
  permission: string;
  /** Segregation of duties: actor must differ from whoever started the instance. */
  requireDifferentFromStarter?: boolean;
  commentRequired?: boolean;
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
}

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
    // AI output is only ever a proposal; a human with ai:approve must decide before anything can act on it.
    type: 'ai_proposal_review', version: 1, initialState: 'PENDING_REVIEW', terminalStates: ['APPROVED', 'REJECTED'],
    transitions: [
      { action: 'approve', from: ['PENDING_REVIEW'], to: 'APPROVED', permission: 'ai:approve' },
      { action: 'reject', from: ['PENDING_REVIEW'], to: 'REJECTED', permission: 'ai:approve', commentRequired: true },
    ],
  },
];
