/** Public brand snapshot API. Transport authentication and composition are caller-owned. */
export { brandKitSchema, brandRevisionSchema, revisionNumberSchema, expectedRevisionSchema } from "./src/schemas.js";
export type { BrandKit, BrandRevision } from "./src/schemas.js";
export type { BrandRepoPort } from "./src/ports.js";
export { saveBrandDraft, confirmBrandRevision, getBrandRevision, getConfirmedBrand } from "./src/service.js";
export { createMemoryBrandRepo } from "./src/adapters/memory.js";
export { createSqlBrandRepo } from "./src/adapters/sql.js";
