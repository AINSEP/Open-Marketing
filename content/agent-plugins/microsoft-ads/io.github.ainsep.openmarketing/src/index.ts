/** Sole public entry; imports and factory construction perform no I/O. */
export { createMicrosoftAdsAdapter } from "./transport.js";
export { microsoftAdsTools, commandSchema } from "./commands.js";
export type { MicrosoftAdsCommand } from "./commands.js";
export type { MicrosoftAdsConfiguration, MicrosoftAdsWireRequest, MicrosoftAdsCredentialPort, MicrosoftAdsGatewayPort, MicrosoftAdsArchiveReader, MicrosoftAdsDependencies, MicrosoftAdsInvocation, MicrosoftAdsResult, MicrosoftAdsAdapter } from "./ports.js";
export type { MicrosoftAdsReport } from "./reporting.js";
