import { z } from 'zod';
import { idSchema, epochSchema, callContextSchema, toolCallSchema, toolOperationSchema, digestSchema,
    confirmationCardSchema, approvalChoiceSchema } from '@open-marketing/contracts';
import type { CreativeService } from '@open-marketing/creative';
import type { DispatchPermit, EffectRequest, FrozenDispatchRequest, SafetyService } from '@open-marketing/safety';
import { effectRequestSchema } from '@open-marketing/safety';
import type { routes } from './cli/http.js';
import type { ApproverRef, ApprovalResponse, CallContext, CallOptions, ConfirmationCard, Outcome, ToolCall, ToolDescriptor, ToolOperation, ToolResult } from '@open-marketing/contracts';

/** Leaf dispatcher contract shared by owner ingress and the catalog implementation.
 * Unknown outcomes remain queryable for reconciliation and never authorize a retry.
 * @example const operation = await tools.operation({ context, operationId });
 */
export interface OmTools {
    list(required: { context: CallContext; query?: string; limit: number }): Promise<Outcome<readonly ToolDescriptor[]>>;
    describe(required: { context: CallContext; name: string }): Promise<Outcome<ToolDescriptor>>;
    dispatch(required: { context: CallContext; call: ToolCall; signal?: AbortSignal }): Promise<Outcome<ToolResult>>;
    operation(required: { context: CallContext; operationId: string }): Promise<Outcome<ToolOperation>>;
    card(required: { context: CallContext; operationId: string }): Promise<Outcome<ConfirmationCard | null>>;
    answer(required: { context: CallContext; response: ApprovalResponse; approver: ApproverRef }): Promise<Outcome<void>>;
    /** Boot-only owner recovery; no callbacks run and old agent authority is discarded. */
    restore(required: { context: CallContext }): Promise<Outcome<void>>;
    /** Rejects with a non-retryable boundary error if cancellation cannot be persisted/revoked. */
    cancel(required: { context: CallContext; runId: string }): Promise<void>;
    dispose(required: Record<string, never>): Promise<void>;
}

/** Stored data only; no credentials, callbacks or restored agent authority. */
/** Validate durable snapshots before the dispatcher can restore them. */
export const storedToolOperationSchema = z.strictObject({ context: callContextSchema, call: toolCallSchema,
    digest: digestSchema, revision: digestSchema, policy: z.enum(['read', 'write', 'destructive', 'spend', 'generation', 'internal']),
    expiresAt: epochSchema, card: confirmationCardSchema.optional(), approvalId: idSchema.optional(), grantChoice: approvalChoiceSchema.optional(),
    classification: confirmationCardSchema.shape.classification, state: toolOperationSchema, executing: z.boolean(),
    request: effectRequestSchema });
export type StoredToolOperation = Omit<z.infer<typeof storedToolOperationSchema>, 'request'> & { request: EffectRequest };

/** Local sandbox generation input; the server owns capability/configuration/pricing/digests.
 * A vendor binding must replace this explicitly labelled fixture before accepting vendor models. */
export const creativeToolInputSchema = z.strictObject({ prompt: z.string().min(1).max(32768), surface: z.enum(['image', 'video', 'audio']),
    model: z.literal('sandbox'), rightsEvidenceId: idSchema, deadlineAt: epochSchema });
export type CreativeToolInput = z.infer<typeof creativeToolInputSchema>;
/** Application binding to the real creative lifecycle plus the one verified safety dispatcher. */
export interface CreativeToolBinding {
    service: CreativeService;
    safety: SafetyService;
    prepareEffect(required: { context: CallContext; call: ToolCall }, optional?: CallOptions): Promise<Outcome<EffectRequest>>;
    dispatchQueued(required: { context: CallContext; generationId: string; operationId: string; argumentsDigest: string }): Promise<Outcome<unknown>>;
    generate(required: { context: CallContext; input: CreativeToolInput; authorization: FrozenDispatchRequest; permit: DispatchPermit }): Promise<Outcome<unknown>>;
}
export type OmToolPolicy = 'read' | 'write' | 'destructive' | 'spend' | 'generation' | 'internal';

/** Known irreversible effects win over unknown declarations, which always contribute write.
 * @complexity O(e) time/space, e <=10 after wire validation; no authority is inferred here.
 */
export function toolPolicy(required: { effects: readonly string[] }): OmToolPolicy {
    if (required.effects.includes('conversion') || required.effects.includes('halt_stop')) return 'internal';
    if (required.effects.includes('ad_spend')) return 'spend';
    if (required.effects.includes('destructive')) return 'destructive';
    if (required.effects.includes('generation')) return 'generation';
    return required.effects.length > 0 && required.effects.every(effect => effect === 'read') ? 'read' : 'write';
}

export interface OmToolDefinition extends ToolDescriptor {
    readonly revision: string;
    readonly policy: OmToolPolicy;
    readonly capability: string;
    readonly ownerRoute?: keyof typeof routes;
    /** Only server bindings provide verified financial requests; plugin metadata cannot do so. */
    readonly safety?: SafetyService;
    prepareEffect?(required: { context: CallContext; call: ToolCall }, optional?: CallOptions): Promise<Outcome<EffectRequest>>;
    readonly unavailableReason?: string;
    readonly ownerOnly?: true;
    parse(required: { input: unknown }): Outcome<unknown>;
    invoke(required: { context: CallContext; input: unknown; signal?: AbortSignal; authorization?: FrozenDispatchRequest; permit?: DispatchPermit }): Promise<Outcome<unknown>>;
}
