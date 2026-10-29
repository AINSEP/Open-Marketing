/** Sole public API; importing this server-loaded plugin performs no I/O. */
export { createCapabilities, createPinterestAdsAdapter } from "./transport.js";
export { pinterestAdsTools, commandSchema } from "./commands.js";
export type { PinterestCommand } from "./commands.js";
export type { PinterestConfiguration, PinterestCredentialPort, PinterestGatewayPort, PinterestWireRequest, PinterestInvocation, PinterestResult, PinterestDependencies, PinterestAdsAdapter } from "./ports.js";
export type { PinterestReport } from "./reporting.js";
export { translateCampaign, campaignDeploymentPlanSchema } from "./campaign-translation.js";
export type { CampaignTranslationInput, PinterestPausedPlan } from "./campaign-translation.js";
export { deployCampaignPaused, readCampaignDeployment } from "./campaign-deployment.js";
export type { PinterestDeploymentReferences, PinterestDeploymentResult } from "./campaign-deployment.js";
export { createPinterestCapiBackend } from "./capi.js";
export type { PinterestCapiConfiguration, PinterestConversionInput, PinterestMeasurementGrant, PinterestCapiRequest, PinterestCapiPayload, PinterestConversionOutcome, PinterestConversionAuthorityPort, PinterestCapiDependencies, PinterestCapiBackend } from "./capi.js";
