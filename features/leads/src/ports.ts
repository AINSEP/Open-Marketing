import type { z } from "zod";
import type { CallOptions, Outcome, Page } from "@open-marketing/contracts";
import type { appendSchema, captureSchema, getSchema, historySchema, listSchema, purgeSchema, repoCaptureSchema, stageSchema, Lead, LeadStageEvent } from "./schemas.js";

/** Atomic projection + ledger repository; failures leave both unchanged.
 * Reads are scope-bound; inbox order is ascending lead ID, history ascending revision.
 * @example repo.get({ context, leadId: "lead-1" }) */
export interface LeadsRepoPort {
  capture(required: z.infer<typeof repoCaptureSchema>, optional?: CallOptions): Promise<Outcome<Lead>>;
  appendStage(required: z.infer<typeof appendSchema>, optional?: CallOptions): Promise<Outcome<Lead>>;
  get(required: z.infer<typeof getSchema>, optional?: CallOptions): Promise<Outcome<Lead | null>>;
  list(required: z.infer<typeof listSchema>, optional?: CallOptions): Promise<Outcome<Page<Lead>>>;
  history(required: z.infer<typeof historySchema>, optional?: CallOptions): Promise<Outcome<Page<LeadStageEvent>>>;
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
