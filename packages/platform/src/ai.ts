import { z } from 'zod';
import { Events } from '@uk/contracts';
import { getCorrelationId, notFound, sha256Hex, unprocessable, AppError, type Logger } from '@uk/core';
import type { AiProposal, Database, Tx } from '@uk/db';
import { publishEvent } from './outbox';
import { WorkflowEngine, type Actor } from './workflow';

/** Port to any model vendor (Anthropic, OpenAI, Bedrock, local). Business code never imports a vendor SDK. */
export interface AiProvider {
  readonly id: string;
  readonly models: readonly string[];
  complete(req: { model: string; system?: string; prompt: string; maxTokens?: number }): Promise<{ text: string; promptTokens?: number; completionTokens?: number }>;
}

const PII: [RegExp, string][] = [
  // deliberately lenient (any 2 letters + 6 digits + suffix): over-redacting is safer than leaking
  [/\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi, '[NI_NUMBER]'],
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[EMAIL]'],
  [/\b\d{2}-\d{2}-\d{2}\b/g, '[SORT_CODE]'],
  [/\b(?:\d[ -]?){13,19}\b/g, '[CARD_NUMBER]'],
  [/\b(?:IBAN\s*)?GB\d{2}\s?[A-Z]{4}(?:\s?\d){14}\b/gi, '[IBAN]'],
  [/\b(?:utr|unique taxpayer reference)\D{0,12}(\d{5}\s?\d{5})\b/gi, '[UTR]'],
  [/\baccount(?: number| no\.?)?\D{0,5}\d{8}\b/gi, '[ACCOUNT_NUMBER]'],
];
/** Minimise personal/financial identifiers before text leaves the platform. */
export const redactPii = (text: string): string => PII.reduce((t, [re, label]) => t.replace(re, label), text);

export class AiGateway {
  private readonly providers: Map<string, AiProvider>;
  /** `db` lets failures be logged in their own transaction, so the audit trail survives a rolled-back caller. */
  constructor(providers: AiProvider[], private readonly logger: Logger, private readonly db?: Database, private readonly defaultProviderId?: string) {
    this.providers = new Map(providers.map((p) => [p.id, p]));
  }
  get available() { return this.providers.size > 0; }

  /** Redacts, calls the provider, and logs the run (hashes only — never prompt or answer text). */
  async complete(tx: Tx, ctx: { organisationId: string; userId?: string | null; purpose: string }, req: { prompt: string; system?: string; model?: string; provider?: string }) {
    const provider = this.providers.get(req.provider ?? this.defaultProviderId ?? [...this.providers.keys()][0] ?? '');
    if (!provider) throw new AppError(503, 'ai_unavailable', 'No AI provider is configured');
    const model = req.model ?? provider.models[0]!;
    if (!provider.models.includes(model)) throw unprocessable(`Model ${model} is not offered by ${provider.id}`, 'unknown_model');
    const prompt = redactPii(req.prompt), system = req.system ? redactPii(req.system) : undefined;
    const base = { organisationId: ctx.organisationId, userId: ctx.userId ?? null, purpose: ctx.purpose, provider: provider.id, model, inputHash: sha256Hex(`${system ?? ''}\n${prompt}`), correlationId: getCorrelationId() };
    const t0 = Date.now();
    try {
      const out = await provider.complete({ model, system, prompt });
      const runId = (await tx.aiRun.create({ data: { ...base, status: 'SUCCEEDED', outputHash: sha256Hex(out.text), promptTokens: out.promptTokens, completionTokens: out.completionTokens, latencyMs: Date.now() - t0 }, select: { id: true } })).id;
      return { text: out.text, runId, provider: provider.id, model };
    } catch (err) {
      const failed = { ...base, status: 'FAILED' as const, error: String((err as Error).message).slice(0, 500), latencyMs: Date.now() - t0 };
      if (this.db) await this.db.tenant({ organisationId: ctx.organisationId, userId: ctx.userId ?? undefined }, (t) => t.aiRun.createMany({ data: [failed] }));
      else await tx.aiRun.createMany({ data: [failed] });
      this.logger.error({ purpose: ctx.purpose, provider: provider.id, err: (err as Error).message }, 'ai provider call failed');
      throw err;
    }
  }
}

/** Deterministic provider for development and tests. Never registered in production. */
export class FakeAiProvider implements AiProvider {
  readonly id = 'fake';
  readonly models = ['fake-1'] as const;
  readonly received: string[] = [];
  failNext = false;
  async complete(req: { prompt: string }) {
    this.received.push(req.prompt);
    if (this.failNext) { this.failNext = false; throw new Error('fake provider failure'); }
    return { text: `SUGGESTION(${req.prompt.slice(0, 60)})`, promptTokens: req.prompt.length, completionTokens: 10 };
  }
}

export const aiProposalPayload = z.object({ summary: z.string(), input: z.string().optional() });

/**
 * Proposals are the ONLY thing AI can create, and they are always distinguishable from human decisions:
 *   SUGGESTED -> UNDER_REVIEW -> ACCEPTED | REJECTED
 * Each step is a workflow transition by a human holding ai:approve for the proposal's company (no silent
 * transitions). ACCEPTING changes nothing else: it emits `ai.proposal_decided`, and the owning module applies the
 * recommendation through ITS OWN authorised application service/workflow (posting, filing, ...), after which that
 * service records the application with {@link AiProposalService.recordApplication}. AI code has no path to ledger,
 * posted-record or filing tables. Use cases with a different lifecycle register their own workflow type
 * (see docs/architecture/v0-hierarchy-and-authorisation-design.md §7).
 */
export interface ProposalProvenance {
  provider?: string; model?: string; promptVersion?: string;
  /** 0..1 where the provider supplies one. */
  confidence?: number;
  /** Source evidence the suggestion is based on, e.g. [{type:'document', id}]. */
  sourceEvidence?: { type: string; id: string }[];
}

export class AiProposalService {
  /** `workflowFor` lets a use case plug in its own state machine; the default is ai_proposal_review. */
  constructor(private readonly engine: WorkflowEngine, private readonly workflowFor: (kind: string) => string = () => 'ai_proposal_review') {}

  async create(tx: Tx, a: { organisationId: string; companyId?: string | null; requestedByUserId: string | null; kind: string; payload: unknown; aiRunId?: string } & ProposalProvenance): Promise<AiProposal> {
    if (a.confidence !== undefined && (a.confidence < 0 || a.confidence > 1)) throw unprocessable('confidence must be between 0 and 1', 'invalid_confidence');
    const proposal = await tx.aiProposal.create({ data: {
      organisationId: a.organisationId, companyId: a.companyId ?? null, aiRunId: a.aiRunId, kind: a.kind, payload: a.payload as never, requestedByUserId: a.requestedByUserId,
      provider: a.provider, model: a.model, promptVersion: a.promptVersion, confidence: a.confidence, sourceEvidence: (a.sourceEvidence ?? []) as never,
    } });
    const wf = await this.engine.start(tx, { type: this.workflowFor(a.kind), organisationId: a.organisationId, companyId: a.companyId, subjectType: 'ai_proposal', subjectId: proposal.id, actorUserId: a.requestedByUserId ?? '00000000-0000-0000-0000-000000000000' });
    await tx.aiProposal.update({ where: { id: proposal.id }, data: { workflowInstanceId: wf.id } });
    await publishEvent(tx, Events.aiProposalCreated, { aggregateId: proposal.id, organisationId: a.organisationId, payload: { proposalId: proposal.id, kind: a.kind } });
    return tx.aiProposal.findUniqueOrThrow({ where: { id: proposal.id } });
  }

  private async load(tx: Tx, id: string) {
    const p = await tx.aiProposal.findUnique({ where: { id } });
    if (!p || !p.workflowInstanceId) throw notFound('Proposal not found');
    const inst = await tx.workflowInstance.findUniqueOrThrow({ where: { id: p.workflowInstanceId } });
    return { p, inst };
  }

  /** A human takes the suggestion into review (SUGGESTED -> UNDER_REVIEW). */
  async beginReview(tx: Tx, a: { organisationId: string; proposalId: string; actor: Actor }): Promise<AiProposal> {
    const { p, inst } = await this.load(tx, a.proposalId);
    if (inst.definitionVersion < 2) throw unprocessable('This proposal predates the review step and can be decided directly', 'no_review_step');
    await this.engine.transition(tx, { organisationId: a.organisationId, instanceId: inst.id, action: 'begin_review', actor: a.actor });
    await tx.aiProposal.update({ where: { id: p.id }, data: { status: 'UNDER_REVIEW', reviewStartedByUserId: a.actor.userId, reviewStartedAt: new Date() } });
    return tx.aiProposal.findUniqueOrThrow({ where: { id: p.id } });
  }

  /** The human decision. ACCEPT requires the proposal to be UNDER_REVIEW; REJECT needs a comment. */
  async decide(tx: Tx, a: { organisationId: string; proposalId: string; actor: Actor; decision: 'ACCEPT' | 'REJECT'; comment?: string }): Promise<AiProposal> {
    const { p, inst } = await this.load(tx, a.proposalId);
    const legacy = inst.definitionVersion < 2;
    const action = a.decision === 'ACCEPT' ? (legacy ? 'approve' : 'accept') : 'reject';
    await this.engine.transition(tx, { organisationId: a.organisationId, instanceId: inst.id, action, actor: a.actor, comment: a.comment });
    const status = a.decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED';
    await tx.aiProposal.update({ where: { id: p.id }, data: { status, decidedByUserId: a.actor.userId, decidedAt: new Date(), decisionComment: a.comment } });
    await publishEvent(tx, Events.aiProposalDecided, { aggregateId: p.id, organisationId: a.organisationId, actorUserId: a.actor.userId, payload: { proposalId: p.id, kind: p.kind, decision: status, decidedByUserId: a.actor.userId } });
    return tx.aiProposal.findUniqueOrThrow({ where: { id: p.id } });
  }

  /**
   * Called by the owning application service AFTER it has applied an ACCEPTED recommendation through its own
   * authorised path. Records who applied it and a reference to the resulting record. Only a human actor can apply.
   */
  async recordApplication(tx: Tx, a: { proposalId: string; appliedByUserId: string; reference: string }): Promise<AiProposal> {
    const p = await tx.aiProposal.findUnique({ where: { id: a.proposalId } });
    if (!p) throw notFound('Proposal not found');
    if (p.status !== 'ACCEPTED') throw unprocessable('Only an ACCEPTED proposal can be applied', 'proposal_not_accepted');
    if (p.appliedAt) throw unprocessable('Proposal was already applied', 'proposal_already_applied');
    await tx.aiProposal.update({ where: { id: p.id }, data: { appliedAt: new Date(), appliedByUserId: a.appliedByUserId, appliedReference: a.reference } });
    return tx.aiProposal.findUniqueOrThrow({ where: { id: p.id } });
  }
}
