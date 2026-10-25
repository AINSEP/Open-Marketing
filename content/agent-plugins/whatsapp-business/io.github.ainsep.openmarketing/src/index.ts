/** Inert server-loaded plugin public API; importing this module performs no I/O. */
export { createWhatsAppBusinessAdapter } from "./transport.js";
export { whatsappBusinessTools, whatsappReadCommandSchema } from "./commands.js";
export type { WhatsAppReadCommand, WhatsAppReadData } from "./commands.js";
export type { WhatsAppBusinessAdapter, WhatsAppConfiguration, WhatsAppCredentialPort, WhatsAppDependencies, WhatsAppGatewayPort, WhatsAppInvocation, WhatsAppReadResult, WhatsAppWireRequest } from "./ports.js";
