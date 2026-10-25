/** Sole public entry; imports and factories start no services or network activity. */
export { createVkAdsAdapter } from "./transport.js";
export { commandSchema, vkAdsTools } from "./commands.js";
export type { VkCommand } from "./commands.js";
export type { VkAccount, VkAdsAdapter, VkConfiguration, VkCredential, VkCredentials, VkDependencies, VkInvocation, VkPage, VkReport, VkResult, VkToken } from "./ports.js";
export { translateCampaign } from "./campaign-translation.js";
export type { CampaignTranslationInput } from "./campaign-translation.js";
export { campaignDeploymentPlanSchema, deployCampaignPaused, readCampaignDeployment } from "./campaign-deployment.js";
