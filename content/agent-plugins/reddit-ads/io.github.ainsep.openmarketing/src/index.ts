/** Sole public entry. Factories and imports perform no I/O. */
export { createRedditAdsAdapter } from "./transport.js";
export { redditAdsTools, commandSchema } from "./commands.js";
export type { RedditCommand } from "./commands.js";
export type { RedditConfiguration, RedditCredentialPort, RedditWireRequest, RedditResult, RedditInvocation, RedditAdsAdapter, RedditDependencies } from "./ports.js";
export type { RedditReport } from "./reporting.js";
export { translateCampaign } from "./campaign-translation.js";
export { campaignDeploymentPlanSchema, deployCampaignPaused, readCampaignDeployment } from "./campaign-deployment.js";
