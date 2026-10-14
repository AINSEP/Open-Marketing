import { z } from 'zod';
import { idSchema, epochSchema } from '@open-marketing/contracts';
import type { CreativeService } from '@open-marketing/creative';
import type { DispatchPermit, EffectRequest, FrozenDispatchRequest, SafetyService } from '@open-marketing/safety';
import type { ApprovalResponse, CallContext, ConfirmationCard, Outcome, ToolCall, ToolDescriptor, ToolOperation, ToolResult } from '@open-marketing/contracts';

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
    answer(required: { context: CallContext; response: ApprovalResponse }): Promise<Outcome<void>>;
    cancel(required: { context: CallContext; runId: string }): void;
    dispose(required: Record<string, never>): void;
}

/** Local sandbox generation input; the server owns capability/configuration/pricing/digests.
 * A vendor binding must replace this explicitly labelled fixture before accepting vendor models. */
export const creativeToolInputSchema = z.strictObject({ prompt: z.string().min(1).max(32768), surface: z.enum(['image', 'video', 'audio']),
    model: z.literal('sandbox'), rightsEvidenceId: idSchema, deadlineAt: epochSchema });
export type CreativeToolInput = z.infer<typeof creativeToolInputSchema>;
/** Application binding to the real creative lifecycle plus the one verified safety dispatcher. */
export interface CreativeToolBinding {
    service: CreativeService;
    safety: SafetyService;
    prepareEffect(required: { context: CallContext; call: ToolCall }): Promise<Outcome<EffectRequest>>;
    dispatchQueued(required: { context: CallContext; generationId: string; operationId: string; argumentsDigest: string }): Promise<Outcome<unknown>>;
    generate(required: { context: CallContext; input: CreativeToolInput; authorization: FrozenDispatchRequest; permit: DispatchPermit }): Promise<Outcome<unknown>>;
}
