/** Web-events public API; factories are inert and all dependencies are injected. */
export * from "./src/types.js";
export * from "./src/ports.js";
export * from "./src/service.js";
export { createMemoryWebEventRepo } from "./src/memory.js";
export { createSqlWebEventRepo } from "./src/sql.js";
export { webEventSnippetSource } from "./src/snippet.js";
