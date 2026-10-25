/** Sole public entry; all execution stays in the server-loaded vendor plugin. */
export { createAmazonAdsAdapter } from "./transport.js";
export { amazonAdsTools, commandSchema } from "./commands.js";
export type { AmazonCommand } from "./commands.js";
export type { AmazonConfiguration, AmazonCredentialPort, AmazonDependencies, AmazonInvocation, AmazonAdsAdapter, AmazonResult } from "./ports.js";
