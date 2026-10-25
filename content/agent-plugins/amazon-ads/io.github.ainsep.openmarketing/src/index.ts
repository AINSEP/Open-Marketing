/** Sole public entry; all execution stays in the server-loaded vendor plugin. */
export { createAmazonAdsAdapter } from "./transport.js";
export { amazonAdsTools, commandSchema } from "./commands.js";
export type { AmazonCommand } from "./commands.js";
export type { AmazonConfiguration, AmazonCredentialPort, AmazonDependencies, AmazonInvocation, AmazonAdsAdapter, AmazonResult } from "./ports.js";
export { translateCampaign, campaignDeploymentPlanSchema } from "./campaign-translation.js";
export type { CampaignTranslationInput, AmazonDeploymentPlan } from "./campaign-translation.js";
export { deployCampaignPaused, readCampaignDeployment } from "./campaign-deployment.js";
export type { AmazonDeploymentResult } from "./campaign-deployment.js";
