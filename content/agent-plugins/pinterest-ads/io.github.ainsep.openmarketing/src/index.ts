/** Sole public API; importing this server-loaded plugin performs no I/O. */
export { createPinterestAdsAdapter } from "./transport.js";
export { pinterestAdsTools, commandSchema } from "./commands.js";
export type { PinterestCommand } from "./commands.js";
export type { PinterestConfiguration, PinterestCredentialPort, PinterestGatewayPort, PinterestWireRequest, PinterestInvocation, PinterestResult, PinterestDependencies, PinterestAdsAdapter } from "./ports.js";
export type { PinterestReport } from "./reporting.js";
