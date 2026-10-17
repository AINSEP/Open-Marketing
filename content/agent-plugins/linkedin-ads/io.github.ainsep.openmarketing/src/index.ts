/** Sole public API. Imports and factories start no services and perform no I/O. */
export { translateCampaign } from "./campaign-translation.js";
export { deployCampaignPaused, readCampaignDeployment, campaignDeploymentPlanSchema } from "./campaign-deployment.js";
export type { LinkedInDeploymentResult } from "./campaign-deployment.js";
export type { CampaignTranslationInput, LinkedInDraftPlan } from "./campaign-translation.js";
export { createLinkedInAdsAdapter } from "./transport.js";
export { linkedinAdsTools, commandSchema, encodeLinkedInCommand, linkedInDigest } from "./commands.js";
export type { LinkedInCommand, LinkedInEncodedCommand } from "./commands.js";
export type { LinkedInConfiguration, LinkedInCredentialPort, LinkedInWireRequest, LinkedInGatewayPort, LinkedInResult, LinkedInInvocation, LinkedInStopInput, LinkedInAdsAdapter, LinkedInDependencies } from "./ports.js";
export { createLinkedInCapiBackend } from "./capi.js";
export type { LinkedInCapiConfiguration, LinkedInConversionInput, LinkedInMeasurementGrant, LinkedInCapiRequest, LinkedInCapiPayload, LinkedInConversionOutcome, LinkedInConversionAuthorityPort, LinkedInCapiDependencies, LinkedInCapiBackend } from "./capi.js";
export type { LinkedInReport } from "./reporting.js";
