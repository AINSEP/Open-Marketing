export { createWorkspaceService } from "./src/service.js";
export type { SessionReference, AccountBinding, VerifiedIdentity, WorkspaceService } from "./src/types.js";
export type { WorkspaceRepoPort, IdentityPort, AccountBindingLookupPort, WorkspaceObserverPort } from "./src/ports.js";
export { createMemoryIdentity, createMemoryAccountBindingLookup, createMemoryWorkspaceObserver } from "./src/memory.js";
export type { Outcome, CallContext, CallOptions, ClockPort, IdPort, Scope, ConfirmationCard, HaltStopRequest, HaltStopPermit, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, MeasurementGrant } from "@open-marketing/contracts";

export { createSqlAccountBindingLookup } from "./src/sql.js";
export type { WorkspaceSqlDatabase, WorkspaceSqlSession } from "./src/sql.js";
export type { WorkspaceRecord, WorkspaceConnectionRecord, WorkspaceRepository } from "./src/store.js";
export type { MemorySession, MemoryIdentity } from "./src/memory.js";

export { createWorkspaceRecord } from "./src/store.js";
export { createMemoryWorkspaceRepo } from "./src/adapters/memory-store.js";
export { createSqlWorkspaceRepo } from "./src/adapters/sql-store.js";
