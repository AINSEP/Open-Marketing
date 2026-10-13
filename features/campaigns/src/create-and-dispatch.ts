import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { CampaignDraft, CampaignReceipt } from "./types.js";
import type { CampaignDependencies } from "./dependencies.js";
import { prepareCreation } from "./create.js";
import { dispatchOperation } from "./dispatch.js";
import { createInputSchema, parseBoundary, fail } from "./rules.js";
import { readCampaign } from "./repo-rules.js";

/** Validates and snapshots caller input before any await, then creates and reads durable state. */
export async function createAndDispatch(required: { dependencies: CampaignDependencies; input: { context: CallContext; draft: CampaignDraft } }, optional?: CallOptions): Promise<Outcome<CampaignReceipt>> {
  const parsed = parseBoundary({ schema: createInputSchema, input: required.input });
  if (!parsed.ok) return parsed;
  const input = parsed.value;
  const saved = await prepareCreation({ dependencies: required.dependencies, input }, optional);
  if (!saved.ok) return saved;
  const dispatch = await dispatchOperation({ dependencies: required.dependencies, input: { context: input.context, operationId: input.draft.operationId } }, optional);
  if (!dispatch.ok) return dispatch;
  const record = await readCampaign({ repo: required.dependencies.repo, context: input.context, campaignId: saved.value.campaignId }, optional);
  if (!record.ok) return record;
  if (!record.value) return fail({ code: "unavailable", message: "Saved campaign disappeared" });
  return { ok: true, value: record.value.receipt };
}
