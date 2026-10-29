import type { CallContext, CallOptions, Outcome } from '@open-marketing/contracts';
/** Append-only lifecycle evidence; contents and credentials never enter the audit. */
export interface PluginAuditPort {
    record(required: { context: CallContext; pluginId: string; operation: string; operationId: string }, optional?: CallOptions): Promise<Outcome<void>>;
}
