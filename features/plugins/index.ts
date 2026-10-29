export { createPluginService } from './src/service.js';
export { addonBoundary, addonFailure } from './src/results.js';
export type { PluginService, AddonDependencies, AddonRepository, AddonPackageAdapter, PreparedAddon, AddonDescription } from './src/types.js';
export type { PluginAuditPort } from './src/ports.js';
export { createMemoryPluginRepo, createMemoryPluginAudit, createMemoryPluginObserver } from './src/memory.js';
