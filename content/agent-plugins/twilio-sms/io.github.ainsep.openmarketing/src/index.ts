/** Sole public entry. Import and factory creation perform no I/O or registration. */
export { createTwilioSmsAdapter } from "./transport.js";
export { commandSchema, configurationSchema, invocationSchema, readDataSchema, twilioSmsTools, encodeTwilioRead, decodeTwilioRead } from "./commands.js";
export type { TwilioConfiguration, TwilioCommand, TwilioReadData, TwilioCredentialPort, TwilioGatewayPort, TwilioResult, TwilioInvocation, TwilioSmsAdapter, TwilioDependencies } from "./ports.js";
