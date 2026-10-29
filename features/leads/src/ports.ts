import type { z } from "zod";
import type { CallOptions, Outcome, Page } from "@open-marketing/contracts";
import type { appendSchema, captureSchema, cohortSchema, getSchema, historySchema, listSchema, purgeSchema, repoCaptureSchema, stageSchema, Lead, LeadCohortCounts, LeadStageEvent } from "./schemas.js";

/** Atomic projection + ledger repository; failures leave both unchanged.
 * Reads are scope-bound; inbox order is ascending lead ID, history ascending revision.
 * @example repo.get({ context, leadId: "lead-1" }) */
export interface LeadsRepoPort {
  capture(required: z.infer<typeof repoCaptureSchema>, optional?: CallOptions): Promise<Outcome<Lead>>;
  appendStage(required: z.infer<typeof appendSchema>, optional?: CallOptions): Promise<Outcome<Lead>>;
  get(required: z.infer<typeof getSchema>, optional?: CallOptions): Promise<Outcome<Lead | null>>;
  list(required: z.infer<typeof listSchema>, optional?: CallOptions): Promise<Outcome<Page<Lead>>>;
  history(required: z.infer<typeof historySchema>, optional?: CallOptions): Promise<Outcome<Page<LeadStageEvent>>>;
  /** Non-spam leads created in [start, end): per attributed campaign of this plugin/account, plus
   * the workspace-wide unattributed count. Erased/disqualified leads count. >5,000 groups → limit_exceeded. */
  readCohort(required: z.infer<typeof cohortSchema>, optional?: CallOptions): Promise<Outcome<LeadCohortCounts>>;
  /** Detach subject links and prohibit revival; callers traverse contact lineage. */
  purgeSubject(required: z.infer<typeof purgeSchema>, optional?: CallOptions): Promise<Outcome<void>>;
}
/** Authenticated backend operations; agent mutations must pass the server's generic exact card.
 * Attribution is server-computed evidence, never a client-supplied wire property.
 * @example service.setStage({ context, leadId: "lead-1", to: "won", expectedRevision: 1, changeId: "change-1" }) */
export interface LeadsService extends Omit<LeadsRepoPort, "capture" | "appendStage"> {
  capture(required: z.infer<typeof captureSchema>, optional?: CallOptions): Promise<Outcome<Lead>>;
  setStage(required: z.infer<typeof stageSchema>, optional?: CallOptions): Promise<Outcome<Lead>>;
}
