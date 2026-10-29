/** Sole public API. Importing and constructing the adapter performs no I/O. */
export { createAmazonSesAdapter } from "./transport.js";
export { createAmazonSesMailProvider, sesMailRequestSchema, sesMailConfigurationSchema, sesSnsEnvelopeSchema } from "./mail.js";
export { default } from "./mail.js";
export type { SesMailRequest, SesMailConfiguration, SesSnsEnvelope } from "./mail.js";
export { amazonSesTools, commandSchema, sesCredentialSchema } from "./commands.js";
export type { SesCommand, SesCredentials, SesData } from "./commands.js";
export type { AmazonSesAdapter, SesConfiguration, SesCredentialPort, SesGatewayPort, SesDependencies, SesInvocation, SesResult, SesWireRequest } from "./ports.js";
