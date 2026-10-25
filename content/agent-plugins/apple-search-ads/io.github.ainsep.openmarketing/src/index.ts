/** Sole public entry; imports perform no I/O. Server composition owns authority and credentials. */
export { invokeAppleSearchAds } from "./transport.js";
export { appleSearchAdsTools, commandSchema } from "./commands.js";
export type { AppleSearchAdsCommand } from "./commands.js";
export type { AppleSearchAdsConfiguration, AppleSearchAdsDependencies, AppleSearchAdsPage, AppleSearchAdsResult } from "./transport.js";
export type { AppleSearchAdsReport } from "./reporting.js";
