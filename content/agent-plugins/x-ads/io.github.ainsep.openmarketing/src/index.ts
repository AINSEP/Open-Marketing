/** Sole public API; no startup, credential lookup, or egress on import. */
export { invokeXAds } from "./transport.js";
export { xAdsTools, commandSchema } from "./commands.js";
export type { XCommand } from "./commands.js";
export type { XConfiguration, XDependencies, XResult } from "./transport.js";
export type { XReport } from "./reporting.js";
