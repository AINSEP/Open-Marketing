/** Inert plugin public API; executable stdio startup is confined to bin/mcp-server.mjs. */
export { createCapabilities, createGoogleBusinessProfilePlugin, mapPerformanceToReport } from "./plugin.ts";
export type { GoogleBusinessProfilePlugin, GoogleBusinessProfileDependencies } from "./plugin.ts";
export { bindingSchema, daysSchema, locationPageSchema, performanceSchema, reportingContextSchema } from "./schemas.ts";
export type { Binding, BusinessProfilePerformance, Context, Credential, Days, LocationInput, LocationPage, PerformanceInput, ReportingContext } from "./schemas.ts";
export type { CredentialPort, DeadlinePort } from "./transport.ts";
