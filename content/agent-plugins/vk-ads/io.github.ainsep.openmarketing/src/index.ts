/** Sole public entry; imports and factories start no services or network activity. */
export { createVkAdsAdapter } from "./transport.js";
export { commandSchema, vkAdsTools } from "./commands.js";
export type { VkCommand } from "./commands.js";
export type { VkAccount, VkAdsAdapter, VkConfiguration, VkCredentials, VkDependencies, VkInvocation, VkPage, VkResult } from "./ports.js";
