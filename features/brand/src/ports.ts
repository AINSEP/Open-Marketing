import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { BrandRevision } from "./schemas.js";

/** Trusted server boundary. Contexts are authority supplied by composition, never raw client claims.
 * Inputs/outputs are detached snapshots. append atomically checks the latest revision, enforces
 * unchanged-kit owner confirmation, appends history and advances the current projection.
 * Failures are typed; reads return null only for absence. No adapter starts services or migrates.
 * @example await repo.readConfirmed({ context });
 */
export interface BrandRepoPort {
  read(required: { context: CallContext; revision?: number }, optional?: CallOptions): Promise<Outcome<BrandRevision | null>>;
  readConfirmed(required: { context: CallContext }, optional?: CallOptions): Promise<Outcome<BrandRevision | null>>;
  append(required: { context: CallContext; expectedRevision: number; revision: BrandRevision }, optional?: CallOptions): Promise<Outcome<BrandRevision>>;
}
