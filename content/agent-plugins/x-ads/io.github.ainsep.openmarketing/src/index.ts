/** Sole public API; no startup, credential lookup, or egress on import. */
export { createCapabilities, invokeXAds, reportMetrics, campaignStatus } from "./transport.js";
export { xAdsTools, commandSchema } from "./commands.js";
export type { XCommand } from "./commands.js";
export type { XConfiguration, XDependencies, XResult } from "./transport.js";
export type { XReport } from "./reporting.js";
export { translateCampaign } from "./campaign-translation.js";
export type { CampaignTranslationInput } from "./campaign-translation.js";
export { deployCampaignPaused, readCampaignDeployment, campaignDeploymentPlanSchema } from "./campaign-deployment.js";
export type { XPausedPlan, XDeploymentReferences, XDeploymentResult, XDeploymentDependencies } from "./campaign-deployment.js";
export { deliverConversion, reconcileConversion } from "./capi.js";
export type { XCapiConfiguration, XConversionInput, XMeasurementGrant, XCapiRequest, XConversionOutcome, XCapiPayload, XCapiDependencies } from "./capi.js";

export { metricMapping } from "./reporting.js";
