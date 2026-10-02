import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { CampaignDraft, CampaignReceipt } from "./types.js";
import type { CampaignDependencies } from "./dependencies.js";
import { assetResultSchema, createInputSchema, digest, fail, parseBoundary } from "./rules.js";

/** Saves the paused draft then atomically enqueues creation intent. No provider effect here.
 * A failed enqueue leaves a harmless saved draft; retry uses the same operation identity.
 * @complexity O(c) for at most 100 creative references, one bulk resolution.
 */
export async function prepareCreation(required: { dependencies: CampaignDependencies; input: { context: CallContext; draft: CampaignDraft } }, optional?: CallOptions): Promise<Outcome<CampaignReceipt>> {
  const parsed = parseBoundary({ schema: createInputSchema, input: required.input });
  if (!parsed.ok) return parsed;
  const { context, draft } = parsed.value;
  const ports = required.dependencies;
  const authority = await ports.safety.authorizeCreation({ context, draft }, optional);
  if (!authority.ok) return authority;
  const assets = await ports.assets.resolve({ context, creativeIds: draft.creativeIds }, optional);
  if (!assets.ok) return assets;
  const validated = parseBoundary({ schema: assetResultSchema, input: assets.value });
  if (!validated.ok) return validated;
  if (validated.value.creativeDigest !== draft.creativeDigest) return fail({ code: "conflict", message: "Creative set changed" });
  const saved = await ports.repo.save({ context, draft }, optional);
  if (!saved.ok) return saved;
  const job = await ports.jobs.enqueue({ context, operationId: draft.operationId, argumentsDigest: digest({ value: draft }), intent: { kind: "create", campaignId: saved.value.campaignId, draft } }, optional);
  if (!job.ok) return job;
  return saved;
}

