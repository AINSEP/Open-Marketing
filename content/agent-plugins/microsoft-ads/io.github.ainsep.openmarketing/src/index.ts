/** Sole public entry; imports and factory construction perform no I/O. */
export { createMicrosoftAdsAdapter, reportMetrics, campaignStatus } from "./transport.js";
export { microsoftAdsTools, commandSchema } from "./commands.js";
export type { MicrosoftAdsCommand } from "./commands.js";
export type { MicrosoftAdsConfiguration, MicrosoftAdsWireRequest, MicrosoftAdsCredentialPort, MicrosoftAdsGatewayPort, MicrosoftAdsArchiveReader, MicrosoftAdsDependencies, MicrosoftAdsInvocation, MicrosoftAdsResult, MicrosoftAdsAdapter } from "./ports.js";
export type { MicrosoftAdsReport } from "./reporting.js";
export { translateCampaign } from "./campaign-translation.js";
export type { CampaignTranslationInput, MicrosoftPausedPlan } from "./campaign-translation.js";
export { campaignDeploymentPlanSchema, deployCampaignPaused, readCampaignDeployment } from "./campaign-deployment.js";
export type { DeploymentInput, DeploymentReadInput, MicrosoftDeploymentResult, MicrosoftDeploymentReferences, MicrosoftDeploymentCheckpoint } from "./campaign-deployment.js";
export { createConversionDelivery } from "./capi.js";
export type { MicrosoftAdsConversionConfiguration, MicrosoftAdsConversionRequest, MicrosoftAdsConversionOutcome, MicrosoftAdsConversionPayload, MicrosoftAdsConversionAuthority, MicrosoftAdsConversionDependencies, MicrosoftAdsConversionBackend } from "./capi.js";

export { metricMapping } from "./reporting.js";
export { createCapabilities } from "./capabilities.js";
