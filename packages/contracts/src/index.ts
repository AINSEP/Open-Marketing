/** Pure OM protocol/value public API. */
export { captureEventSchema, recentEventsSchema } from './telemetry/index.js';
export type { CaptureEvent, RecentEvents } from './telemetry/index.js';
export { PROTOCOL_VERSION, runGrantMetadataSchema, startRunSchema, cancelRunSchema, eventCursorSchema, runEventSchema, eventSubscriptionSchema } from "./agent/index.js";
export type { RunGrantMetadata, ServiceControlCredential, StartRunRequest, CancelRunRequest, RunEvent, EventSubscription, RunReceipt, CancellationReceipt, AgentHealth } from "./agent/index.js";
export { navigationTargetSchema, navigationActionSchema, navigationResultSchema, approvalChoiceSchema, confirmationCardSchema, approvalResponseSchema, mcpRequestSchema, chatMessageSchema } from "./api/index.js";
export type { NavigationTarget, NavigationAction, NavigationResult, ConfirmationCard, ApprovalResponse, OmMcpRequest, ChatMessage } from "./api/index.js";
export { effectCategorySchema, moneyExposureSchema, dailyLimitRequirementSchema, effectEnvelopeSchema, capabilityEnvelopeSchema, generationCostQuoteSchema, generationAllowanceSettingsSchema, DEFAULT_GENERATION_ALLOWANCE, generationApprovalRequirementSchema, haltStopRequestSchema, measurementGrantSchema } from "./capabilities/index.js";
export type { EffectCategory, MoneyExposure, DailyLimitRequirement, EffectEnvelope, CapabilityEnvelope, GenerationCostQuote, GenerationAllowanceSettings, GenerationApprovalRequirement, HaltStopRequest, HaltStopPermit, MeasurementGrant } from "./capabilities/index.js";
export { idSchema, epochSchema, digestSchema, moneySchema, timeWindowSchema, scopeSchema, principalSchema, appErrorSchema, callContextSchema, pageQuerySchema, notImplemented, parseBoundary } from "./values/index.js";
export type { AppError, Outcome, Scope, Principal, Money, TimeWindow, OperationId, CallContext, ServiceContext, CallOptions, ClockPort, IdPort, ObserverEvent, ObserverPort, PageQuery, Page } from "./values/index.js";
export { addonNavigationTargetSchema, chatAttachmentSchema, studioNavigationTargetSchema, boundedJsonSchema, assistantSettingsSchema, assistantSettingsStatusSchema, assistantRunRequestSchema, conversationSummarySchema, conversationListSchema, conversationSchema, conversationReadSchema, assistantContextSchema, toolDescriptorSchema, toolSearchSchema, toolCallSchema, toolResultSchema, toolOperationSchema } from "./api/index.js";
export type { AddonNavigationTarget, ChatAttachmentRef, StudioNavigationTarget, AssistantSettings, AssistantSettingsStatus, AssistantRunRequest, ConversationSummary, ConversationList, Conversation, ConversationRead, AssistantContext, ToolDescriptor, ToolSearch, ToolCall, ToolResult, ToolOperation } from "./api/index.js";
export { toolRequestedPayloadSchema, toolResultPayloadSchema, approvalPayloadSchema, operationPollSchema, frontendInvocationSchema, frontendResultSchema, a2uiSurfacePayloadSchema, surfaceAcknowledgementSchema } from "./agent/index.js";
export type { ToolRequestedPayload, ToolResultPayload, ApprovalPayload, OperationPoll, FrontendInvocation, FrontendResult, A2uiSurfacePayload, SurfaceAcknowledgement } from "./agent/index.js";
export { addonKindSchema, addonSummarySchema, addonListRequestSchema, addonListSchema, setAddonEnabledSchema, uninstallAddonSchema, addonUninstallReceiptSchema, addonUploadSchema, installAddonSchema, addonToolEffectsSchema, addonToolSourceSchema, integrationSummarySchema, integrationListSchema, connectIntegrationTokenSchema, disconnectIntegrationSchema, chartProviderDescriptorSchema, chartProviderListSchema } from "./addons/index.js";
export type { AddonKind, AddonSummary, AddonListRequest, AddonList, SetAddonEnabled, UninstallAddon, AddonUninstallReceipt, AddonUpload, InstallAddon, AddonToolSource, IntegrationSummary, IntegrationList, ConnectIntegrationToken, DisconnectIntegration, ChartProviderDescriptor, ChartProviderList } from "./addons/index.js";
export { oauthClientStatusSchema, oauthStatusSchema, oauthChallengeSchema } from "./addons/index.js";
export { pluginSecretQuerySchema, pluginSecretSetSchema, pluginSecretStatusSchema, cardSchema, credentialCardSchema, credentialPluginStatusSchema } from "./addons/index.js";
export type { PluginSecretQuery, PluginSecretSet, PluginSecretStatus, CredentialCard } from "./addons/index.js";
export { pluginToolSchema, definePluginTools } from "./addons/index.js";
export type { PluginTool, PluginToolInvocation, PluginToolsFactory } from "./addons/index.js";
export { mailAdapterDescriptorSchema, mailManifestExtensionSchema, mailProviderSelectionSchema, mailProviderSettingsSchema } from "./addons/index.js";
export type { MailAdapterDescriptor, MailManifestExtension, MailProviderSelection, MailProviderSettings } from "./addons/index.js";

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

export { assistantUsageSchema, assistantProviderSchema, assistantRuntimeSchema, modelProtocolSchema } from './api/index.js';
export type { AssistantProvider, AssistantUsage, ModelProtocol } from './api/index.js';
export { modelProviderSchema } from './addons/index.js';
export type { ModelProvider } from './addons/index.js';
export { metricGrainSchema, metricValuesSchema, metricMappingSchema, metricBatchSchema, ratioResultSchema, deriveMetricRatios, decimalToMicros } from './metrics/index.js';
export type { MetricGrain, MetricValues, MetricMapping, MetricBatch, RatioResult, MetricRatios } from './metrics/index.js';
export { campaignValidateInputSchema, campaignValidateOutputSchema, campaignValidationEvidenceSchema, capabilityIdSchema, capabilityCatalog, reportMetricsInputSchema, campaignStatusInputSchema, campaignStatusOutputSchema, trackingTagInputSchema, trackingTagOutputSchema, effectiveCapabilityEffects, pluginConfigurationSchema, pluginConnectionConfigurationSchema } from './capabilities/index.js';
export type { CampaignValidateInput, CampaignValidateOutput, CampaignValidationEvidence, CapabilityId, CallableCapabilityId, CapabilityInput, CapabilityOutput, PluginCapability, PluginCapabilityDependencies, PluginCapabilities, PluginCapabilitiesFactory, PluginConfiguration, PluginConnectionConfiguration, ReportMetricsInput, CampaignStatusInput, CampaignStatusOutput, TrackingTagInput, TrackingTagOutput } from './capabilities/index.js';
export { campaignKeySchema, encodeCampaignKey, parseCampaignKey, approverRefSchema, dispatchDecisionSchema, serviceContextSchema, parseExactIntegerJson, canonicalizeArguments } from './values/index.js';
export type { CampaignKey, ApproverRef, DispatchDecision } from './values/index.js';
export { neutralCampaignLaunchSchema, neutralCampaignRecordSchema, saveNeutralCampaignSchema } from './launch/index.js';
export type { NeutralCampaignLaunch, NeutralCampaignRecord } from './launch/index.js';
export { campaignDeploymentReceiptSchema } from './launch/index.js';
export type { CampaignDeploymentReceipt, CampaignDeploymentRequired } from './launch/index.js';
