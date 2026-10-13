/** Contacts owns canonical identity, normalization and transient destination hashing. */
export * from "./src/types.js";
export * from "./src/ports.js";
export * from "./src/service.js";
export { normalizeEmail, normalizePhoneE164, identifierDigest, destinationIdentifierHash, toMetaFbc } from "./src/normalize.js";
export { createMemoryContactRepo } from "./src/memory.js";
export { createSqlContactRepo } from "./src/sql.js";
