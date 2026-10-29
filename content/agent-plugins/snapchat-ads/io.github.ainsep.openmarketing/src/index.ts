/** Sole public entry; imports and factories perform no I/O or service startup. */
export { createCapabilities, createSnapchatAdsAdapter } from "./transport.js";
export { commandSchema, snapchatAdsTools } from "./commands.js";
export type { SnapchatCommand } from "./commands.js";
export type { SnapchatConfiguration, SnapchatCredentialPort, SnapchatGatewayPort, SnapchatWireRequest, SnapchatResult, SnapchatInvocation, SnapchatAdsAdapter, SnapchatDependencies } from "./ports.js";
export type { SnapchatReport } from "./reporting.js";
export { translateCampaign, campaignDeploymentPlanSchema } from "./campaign-translation.js";
export type { CampaignTranslationInput, SnapchatPausedPlan } from "./campaign-translation.js";
export { deployCampaignPaused, readCampaignDeployment } from "./campaign-deployment.js";
export type { SnapchatDeploymentDependencies, SnapchatDeploymentInput, SnapchatDeploymentReferences, SnapchatDeploymentResult, SnapchatCapiDependencies, SnapchatConversionAuthorityPort } from "./ports.js";
export { createSnapchatCapiBackend } from "./capi.js";
export type { SnapchatCapiConfiguration, SnapchatCapiRequest, SnapchatCapiPayload, SnapchatConversionOutcome, SnapchatCapiBackend } from "./capi.js";
