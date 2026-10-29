/** Sole public entry; imports perform no I/O. Server composition owns authority and credentials. */
export { invokeAppleSearchAds } from "./transport.js";
export { appleSearchAdsTools, commandSchema } from "./commands.js";
export type { AppleSearchAdsCommand } from "./commands.js";
export type { AppleSearchAdsConfiguration, AppleSearchAdsDependencies, AppleSearchAdsPage, AppleSearchAdsResult } from "./transport.js";
export { translateCampaign, campaignDeploymentPlanSchema } from "./campaign-translation.js";
export type { AppleSearchAdsPlan, AppleSearchAdsTranslationInput } from "./campaign-translation.js";
export { deployCampaignPaused, readCampaignDeployment } from "./campaign-deployment.js";
export type { AppleSearchAdsDeploymentResult } from "./campaign-deployment.js";
