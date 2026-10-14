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
