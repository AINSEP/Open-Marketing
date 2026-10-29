/** Web-events public API: landing claims, observed attribution and collector readiness.
 * Factories are inert; storage, consent and scoped campaign observation are injected. */
export * from "./src/types.js";
export * from "./src/ports.js";
export * from "./src/service.js";
export { createMemoryWebEventRepo } from "./src/memory.js";
export { createSqlWebEventRepo } from "./src/sql.js";
export { webEventSnippetSource, webEventInstallSource } from "./src/snippet.js";
