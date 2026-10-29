/** Lead inbox lifecycle and storage. Construction is inert; all I/O is injected. */
export { leadStageSchema, leadSourceSchema, leadAttributionSchema, leadSchema, leadStageEventSchema } from "./src/schemas.js";
export type { Lead, LeadStage, LeadSource, LeadAttribution, LeadStageEvent } from "./src/schemas.js";
export type { LeadsRepoPort, LeadsService } from "./src/ports.js";
export { createLeadsService } from "./src/service.js";
export { createMemoryLeadsRepo } from "./src/memory.js";
export { createSqlLeadsRepo } from "./src/sql.js";
export { stageSchema, getSchema, listSchema, historySchema } from "./src/schemas.js";
