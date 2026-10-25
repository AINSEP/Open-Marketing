/** Sole public entry; imports and factories perform no I/O or service startup. */
export { createSnapchatAdsAdapter } from "./transport.js";
export { commandSchema, snapchatAdsTools } from "./commands.js";
export type { SnapchatCommand } from "./commands.js";
export type { SnapchatConfiguration, SnapchatCredentialPort, SnapchatGatewayPort, SnapchatWireRequest, SnapchatResult, SnapchatInvocation, SnapchatAdsAdapter, SnapchatDependencies } from "./ports.js";
export type { SnapchatReport } from "./reporting.js";
