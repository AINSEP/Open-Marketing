/** Sole public entry; imports and factories do not start services or perform I/O. */
export { createLineAdsAdapter } from "./transport.js";
export { lineAdsTools, commandSchema } from "./commands.js";
export type { LineAdsCommand } from "./commands.js";
export type { LineAdsConfiguration, LineAdsCredentialPort, LineAdsWireRequest, LineAdsResult, LineAdsInvocation, LineAdsAdapter, LineAdsDependencies } from "./ports.js";
