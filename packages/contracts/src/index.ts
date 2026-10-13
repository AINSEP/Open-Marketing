/** Pure OM protocol/value public API. */
export { PROTOCOL_VERSION, runGrantMetadataSchema, startRunSchema, cancelRunSchema, eventCursorSchema, runEventSchema, eventSubscriptionSchema } from "./agent/index.js";
export type { RunGrantMetadata, ServiceControlCredential, RunGrantCredential, StartRunRequest, CancelRunRequest, RunEvent, SseEvent, EventSubscription, RunReceipt, CancellationReceipt, AgentHealth } from "./agent/index.js";
export { navigationTargetSchema, navigationActionSchema, navigationResultSchema, approvalChoiceSchema, confirmationCardSchema, approvalResponseSchema, apiRequestSchema, mcpRequestSchema, chatMessageSchema } from "./api/index.js";
export type { NavigationTarget, NavigationAction, NavigationResult, ConfirmationCard, ApprovalResponse, ApiRequest, ApiResponse, OmMcpRequest, ChatMessage } from "./api/index.js";
export { effectCategorySchema, moneyExposureSchema, dailyLimitRequirementSchema, effectEnvelopeSchema, capabilityEnvelopeSchema, generationCostQuoteSchema, generationAllowanceSettingsSchema, DEFAULT_GENERATION_ALLOWANCE, generationApprovalRequirementSchema, haltStopRequestSchema, measurementGrantSchema } from "./capabilities/index.js";
export type { EffectCategory, MoneyExposure, DailyLimitRequirement, EffectEnvelope, CapabilityEnvelope, GenerationCostQuote, CostQuote, GenerationAllowanceSettings, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, MeasurementGrant, MeasurementServiceGrant } from "./capabilities/index.js";
export { idSchema, epochSchema, digestSchema, moneySchema, timeWindowSchema, scopeSchema, principalSchema, appErrorSchema, callContextSchema, pageQuerySchema, notImplemented, parseBoundary } from "./values/index.js";
export type { AppError, Outcome, Scope, Principal, PrincipalReference, Money, TimeWindow, OperationId, EventCursor, CallContext, ServiceContext, CallOptions, ClockPort, IdPort, ObserverEvent, ObserverPort, PageQuery, Page } from "./values/index.js";

/** One explicit transaction owner. Root work rolls back on a throw or returned {ok:false}.
 * Pass its session to every participating repository; session transactions join the root.
 * Callers must await all work and stop using the session when root work returns.
 * @example await pool.transaction({ work: ({ session }) => session.query({ text: 'SELECT 1' }) });
 */
export interface UnitOfWork {
  transaction<T>(required: { work: (required: { session: SqlSession }) => Promise<T> }): Promise<T>;
}
/** Request-bound SQL access; implementations reject use after the root transaction ends. */
export interface SqlSession extends UnitOfWork {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(required: {
    text: string;
    values?: unknown[];
  }): Promise<{ rows: Row[]; rowCount: number | null }>;
}
