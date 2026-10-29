import type { CallContext, CallOptions, ClockPort, Outcome } from "@open-marketing/contracts";
import type { BrandRepoPort } from "./ports.js";
import { brandFailure, brandRevisionSchema, confirmSchema, contextSchema, draftSchema, parseBrandInput, readSchema } from "./schemas.js";
import type { BrandKit, BrandRevision } from "./schemas.js";

/** Save a complete draft without advancing the confirmed projection. Injected clock and repo only.
 * Returns validation/cancellation/conflict/storage failures. O(b) bounded snapshot, one append.
 * @example await saveBrandDraft({ context, kit, expectedRevision: 0, repo, clock });
 */
export async function saveBrandDraft(required: { context: CallContext; kit: BrandKit; expectedRevision: number; repo: BrandRepoPort; clock: ClockPort }, optional?: CallOptions): Promise<Outcome<BrandRevision>> {
  const input = parseBrandInput({ schema: draftSchema, input: { context: required.context, kit: required.kit, expectedRevision: required.expectedRevision } }, optional);
  if (!input.ok) return input;
  return appendRevision({ ...required, ...input.value, status: "draft" }, optional);
}

/** Confirm only the exact current draft using a trusted matching owner principal.
 * Appends unchanged content; stale targets fail closed. O(b) snapshot, one read and one CAS append.
 * @example await confirmBrandRevision({ context, revision: 1, repo, clock });
 */
export async function confirmBrandRevision(required: { context: CallContext; revision: number; repo: BrandRepoPort; clock: ClockPort }, optional?: CallOptions): Promise<Outcome<BrandRevision>> {
  const input = parseBrandInput({ schema: confirmSchema, input: { context: required.context, revision: required.revision } }, optional);
  if (!input.ok) return input;
  const { context, revision } = input.value;
  if (context.principal.kind !== "owner") return brandFailure({ code: "forbidden", message: "Owner confirmation required" });
  const current = await getBrandRevision({ context, repo: required.repo }, optional);
  if (!current.ok) return current;
  if (current.value?.revision !== revision || current.value.status !== "draft") return brandFailure({ code: "conflict", message: "Confirm the exact current draft" });
  return appendRevision({ ...required, context, kit: current.value.kit, expectedRevision: revision, status: "confirmed" }, optional);
}

/** Read latest or exact history; absence is null, storage/validation/cancellation errors are typed.
 * O(b) bounded returned snapshot plus one repository read. @example await getBrandRevision({ context, repo });
 */
export async function getBrandRevision(required: { context: CallContext; repo: BrandRepoPort; revision?: number }, optional?: CallOptions): Promise<Outcome<BrandRevision | null>> {
  const input = parseBrandInput({ schema: readSchema, input: { context: required.context, revision: required.revision } }, optional);
  if (!input.ok) return input;
  try { return await required.repo.read(input.value, optional); }
  catch { return brandFailure({ code: "unavailable", message: "Brand repository unavailable" }); }
}

/** Read the last confirmed kit even when newer drafts exist. Same typed failures as history reads.
 * O(b) bounded snapshot plus one repository read. @example await getConfirmedBrand({ context, repo });
 */
export async function getConfirmedBrand(required: { context: CallContext; repo: BrandRepoPort }, optional?: CallOptions): Promise<Outcome<BrandRevision | null>> {
  const input = parseBrandInput({ schema: contextSchema, input: { context: required.context } }, optional);
  if (!input.ok) return input;
  try { return await required.repo.readConfirmed(input.value, optional); }
  catch { return brandFailure({ code: "unavailable", message: "Brand repository unavailable" }); }
}

/** Stamp a new immutable revision using injected time, preserving caller trace evidence.
 * Clock/port exceptions return unavailable; schema errors return invalid_input. O(b), one append.
 */
async function appendRevision(required: { context: CallContext; kit: BrandKit; expectedRevision: number; status: BrandRevision["status"]; repo: BrandRepoPort; clock: ClockPort }, optional?: CallOptions): Promise<Outcome<BrandRevision>> {
  try {
    const { context } = required;
    const revision = brandRevisionSchema.safeParse({ scope: context.scope, revision: required.expectedRevision + 1, status: required.status, kit: required.kit, actor: context.principal, at: required.clock.now({}), correlationId: context.correlationId, traceId: context.traceId, runId: context.runId });
    if (!revision.success) return brandFailure({ code: "invalid_input", message: "Invalid brand revision or clock" });
    return await required.repo.append({ context, expectedRevision: required.expectedRevision, revision: revision.data }, optional);
  } catch { return brandFailure({ code: "unavailable", message: "Brand dependency unavailable" }); }
}
