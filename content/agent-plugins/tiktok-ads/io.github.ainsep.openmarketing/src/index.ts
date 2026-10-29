/** Inert, server-loaded public surface. No services, credentials or global fetch are constructed. */
export { translateCampaign } from "./campaign-translation.js";
export type { CampaignTranslationInput } from "./campaign-translation.js";
export { campaignDeploymentPlanSchema, tiktokDeploymentSchemaFingerprint, deployCampaignPaused, readCampaignDeployment } from "./campaign-deployment.js";
export type { TikTokPausedPlan, TikTokDeploymentResult } from "./campaign-deployment.js";
export { tools, parseTool, tiktokCommandSchema, encodeTikTokCommand, decodeTikTokRead } from "./commands.js";
export type { TikTokCommand, TikTokReadCommand, TikTokReportQuery, TikTokPath } from "./commands.js";
export { createTools, createTikTokAdsAdapter, tiktokStopSchemaFingerprint } from "./adapter.js";
export type { TikTokAdsAdapter, TikTokBinding, TikTokInvocation, TikTokResult } from "./adapter.js";
export { createConversionDelivery, tiktokEventsSchemaFingerprint } from "./events.js";
export type { TikTokEventsBackend, TikTokEventsConfiguration, TikTokEventsPayload, TikTokEventsRequest, TikTokConversionEvent, TikTokConversionOutcome, TikTokConversionAuthorityPort } from "./events.js";
export { createTikTokFetchEgress } from "./transport.js";
export { decodeTikTokReport, decimalToMinor, tiktokAccountMetadataSchema } from "./reporting.js";
export type { TikTokAccountMetadata, TikTokReport } from "./reporting.js";
export type { TikTokCredentialPort, TikTokEgressPort, TikTokEgressRequest, TikTokGatewayPort, TikTokCall } from "./ports.js";

export { createCapabilities } from "./capabilities.js";
