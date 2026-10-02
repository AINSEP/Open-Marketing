export { createWorkspaceService } from "./src/service.js";
export type { SessionReference, AccountBinding, VerifiedIdentity, WorkspaceService } from "./src/types.js";
export type { WorkspaceRepoPort, IdentityPort, AccountBindingLookupPort, WorkspaceObserverPort } from "./src/ports.js";
export { createMemoryWorkspaceRepo, createMemoryIdentity, createMemoryAccountBindingLookup, createMemoryWorkspaceObserver } from "./src/memory.js";
export type { Outcome, CallContext, CallOptions, ClockPort, IdPort, Scope, ConfirmationCard, HaltStopRequest, HaltStopPermit, GenerationAllowanceSettings, GenerationCostQuote, GenerationApprovalRequirement, MeasurementGrant } from "@open-marketing/contracts";

export { createSqlWorkspaceRepo, createSqlAccountBindingLookup } from "./src/sql.js";
export type { WorkspaceSqlDatabase, WorkspaceSqlSession } from "./src/sql.js";
export type { WorkspaceRecord, WorkspaceConnectionRecord, WorkspaceRepository } from "./src/store.js";
export type { MemorySession, MemoryIdentity } from "./src/memory.js";
