/** Sole public entry; imports and factories do not start services or perform I/O. */
export { createCapabilities, createLineAdsAdapter } from "./transport.js";
export { lineAdsTools, commandSchema } from "./commands.js";
export { translateCampaign } from "./campaign-translation.js";
export type { CampaignTranslationInput } from "./campaign-translation.js";
export { deployCampaignPaused, readCampaignDeployment, campaignDeploymentPlanSchema } from "./campaign-deployment.js";
export type { LineAdsDeploymentResult } from "./campaign-deployment.js";
export type { LineAdsPausedPlan } from "./commands.js";
export type { LineAdsCommand } from "./commands.js";
export type { LineAdsConfiguration, LineAdsCredentialPort, LineAdsWireRequest, LineAdsResult, LineAdsInvocation, LineAdsAdapter, LineAdsDependencies } from "./ports.js";
