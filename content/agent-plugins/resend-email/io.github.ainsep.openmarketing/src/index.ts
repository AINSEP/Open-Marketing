/** Sole public plugin entry; imports/factories perform no I/O or registration. */
export { createResendEmailAdapter } from "./transport.js";
export { createResendMailProvider, resendMailRequestSchema, resendMailEventSchema } from "./mail.js";
export { default } from "./mail.js";
export type { ResendMailRequest, ResendMailEvent } from "./mail.js";
export { resendEmailTools, commandSchema, domainCommandSchema, encodeResendCommand, resendEmailDigest } from "./commands.js";
export type { ResendCommand, ResendDomain } from "./commands.js";
export type { ResendEmailConfiguration, ResendEmailCredentialPort, ResendEmailGatewayPort, ResendEmailRequest, ResendEmailResult, ResendEmailInvocation, ResendEmailAdapter, ResendEmailDependencies } from "./ports.js";
