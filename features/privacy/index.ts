/** Privacy orchestration; factories are inert and all effects use injected ports. */
export * from "./src/types.js";
export * from "./src/ports.js";
export * from "./src/service.js";
export { createErasureParticipantRegistry } from "./src/registry.js";
export { createMemoryPrivacyRepo } from "./src/memory.js";
export { createSqlPrivacyRepo } from "./src/sql.js";
