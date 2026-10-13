import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { CampaignJobPort } from "./ports.js";
import type { CampaignJob } from "./types.js";
import { digest, exactMatch, fail, jobSchema, parseBoundary, scopeKey, success } from "./rules.js";

/** Check operation and immutable payload identity independently of the outbox adapter.
 * Returns false for substituted intent. @complexity O(n) bounded intent bytes; pure.
 */
export function intentIdentity(required: Pick<CampaignJob, "operationId" | "argumentsDigest" | "intent">): boolean {
  const { operationId, argumentsDigest, intent } = required;
  if (intent.kind === "create") return operationId === intent.draft.operationId && argumentsDigest === digest({ value: intent.draft });
  return operationId === intent.request.operationId && argumentsDigest === intent.request.argumentsDigest && exactMatch({ request: intent.request, proposal: intent.proposal });
}

/** Parse durable jobs and bind them to this scope/key before trusting status or intent.
 * Missing rows remain null; malformed/foreign/substituted rows fail closed.
 * @complexity O(n) bounded job bytes; no I/O.
 */
export function boundJob(required: { context: CallContext; operationId: string; value: unknown }): Outcome<CampaignJob | null> {
  if (required.value === null) return success({ value: null });
  const parsed = parseBoundary({ schema: jobSchema, input: required.value });
  if (!parsed.ok) return parsed;
  if (scopeKey({ scope: parsed.value.scope }) !== scopeKey({ scope: required.context.scope })) return fail({ code: "forbidden", message: "Job scope mismatch" });
  if (parsed.value.operationId !== required.operationId || !intentIdentity(parsed.value)) return fail({ code: "conflict", message: "Job operation identity mismatch" });
  return parsed;
}

/** One scoped outbox read plus boundary validation; adapter failures stay explicit.
 * @complexity One indexed port read and O(n) bounded job validation; no retries.
 */
export async function readJob(required: { jobs: CampaignJobPort; context: CallContext; operationId: string }, optional?: CallOptions): Promise<Outcome<CampaignJob | null>> {
  const result = await required.jobs.get({ context: required.context, operationId: required.operationId }, optional);
  if (!result.ok) return result;
  return boundJob({ ...required, value: result.value });
}
