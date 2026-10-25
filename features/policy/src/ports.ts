import type { Outcome, CallContext, CallOptions, ObserverPort } from "@open-marketing/contracts";
import type { SubjectReference, PolicyService } from "./types.js";
/** Scoped append-only evidence and refreshed policy snapshots; failures are explicit typed values. */
export type PolicyRepoPort = PolicyService;
/** Exact scoped identifier resolution; missing or ambiguous bindings never create identities. */
export interface CanonicalIdentityPort {
 resolve(required: { context: CallContext; identifier: string }, optional?: CallOptions): Promise<Outcome<SubjectReference>>;
}
export type PolicyObserverPort = ObserverPort;
