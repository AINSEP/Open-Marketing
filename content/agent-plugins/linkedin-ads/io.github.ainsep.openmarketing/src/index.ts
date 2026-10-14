/** Sole public API. Imports and factories start no services and perform no I/O. */
export { createLinkedInAdsAdapter } from "./transport.js";
export { linkedinAdsTools, commandSchema, encodeLinkedInCommand, linkedInDigest } from "./commands.js";
export type { LinkedInCommand, LinkedInEncodedCommand } from "./commands.js";
export type { LinkedInConfiguration, LinkedInCredentialPort, LinkedInWireRequest, LinkedInGatewayPort, LinkedInResult, LinkedInInvocation, LinkedInStopInput, LinkedInAdsAdapter, LinkedInDependencies } from "./ports.js";
export { createLinkedInCapiBackend } from "./capi.js";
export type { LinkedInCapiConfiguration, LinkedInConversionInput, LinkedInMeasurementGrant, LinkedInCapiRequest, LinkedInCapiPayload, LinkedInConversionOutcome, LinkedInConversionAuthorityPort, LinkedInCapiDependencies, LinkedInCapiBackend } from "./capi.js";
export type { LinkedInReport } from "./reporting.js";
