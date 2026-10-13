import { z } from "zod";
import { callContextSchema, digestSchema, idSchema } from "@open-marketing/contracts";
import type { CampaignJobPort } from "./ports.js";
import type { CampaignJob } from "./types.js";
import { checkCancelled, proposalGetSchema } from "./repo-rules.js";
import { digest, fail, intentSchema, parseBoundary, scopedKey, success } from "./rules.js";
import { intentIdentity } from "./job-rules.js";
const enqueueSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, argumentsDigest: digestSchema, intent: intentSchema });
const finishSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, status: z.enum(["submitted", "unknown"]) });

/** Atomic in-memory outbox double. Intent+enqueue and CAS claim contain no await gap.
 * Not a production queue; composition adapts the single @open-marketing/jobs outbox.
 * @example createMemoryCampaignJob({}) @complexity O(n) bounded intent bytes; O(1) lookup.
 */
export function createMemoryCampaignJob(required: { maxEntries?: number }): CampaignJobPort {
  const jobs = new Map<string, CampaignJob>();
  const completions: { operationId: string; status: string }[] = [];
  const maxEntries = required.maxEntries ?? 10000;
  return {
    async enqueue(input, options) {
      const parsed = parseBoundary({ schema: enqueueSchema, input });
      if (!parsed.ok) return parsed;
      const cancelled = checkCancelled({ options });
      if (!cancelled.ok) return cancelled;
      const { context, operationId, argumentsDigest, intent } = parsed.value;
      const valid = intentIdentity({ operationId, argumentsDigest, intent });
      if (!valid) return fail({ code: "conflict", message: "Outbox intent identity mismatch" });
      const key = scopedKey({ scope: context.scope, id: operationId });
      const existing = jobs.get(key);
      if (existing) return existingJob({ existing, input: parsed.value });
      if (jobs.size >= maxEntries) return fail({ code: "limit_exceeded", message: "Job capacity reached" });
      const jobId = "job-" + digest({ value: key }).slice(0, 40);
      jobs.set(key, structuredClone({ jobId, scope: context.scope, operationId, argumentsDigest, intent, status: "queued" }));
      return success({ value: { jobId } });
    },
    async get(input, options) {
      const parsed = parseBoundary({ schema: proposalGetSchema, input });
      if (!parsed.ok) return parsed;
      const cancelled = checkCancelled({ options });
      if (!cancelled.ok) return cancelled;
      return success({ value: structuredClone(jobs.get(scopedKey({ scope: parsed.value.context.scope, id: parsed.value.operationId })) ?? null) });
    },
    async claim(input, options) {
      const parsed = parseBoundary({ schema: proposalGetSchema, input });
      if (!parsed.ok) return parsed;
      const cancelled = checkCancelled({ options });
      if (!cancelled.ok) return cancelled;
      const key = scopedKey({ scope: parsed.value.context.scope, id: parsed.value.operationId });
      const job = jobs.get(key);
      if (!job) return fail({ code: "forbidden", message: "Job unavailable in scope" });
      if (job.status !== "queued") return success({ value: null });
      const claimed: CampaignJob = { ...job, status: "dispatching" };
      jobs.set(key, claimed);
      return success({ value: structuredClone(claimed) });
    },
    async finish(input, options) {
      const parsed = parseBoundary({ schema: finishSchema, input });
      if (!parsed.ok) return parsed;
      const cancelled = checkCancelled({ options });
      if (!cancelled.ok) return cancelled;
      const key = scopedKey({ scope: parsed.value.context.scope, id: parsed.value.operationId });
      const job = jobs.get(key);
      if (!job) return fail({ code: "forbidden", message: "Job unavailable in scope" });
      if (job.status === "queued") return fail({ code: "conflict", message: "Unclaimed job cannot finish" });
      if (completions.length >= maxEntries) return fail({ code: "limit_exceeded", message: "Completion evidence capacity reached" });
      completions.push({ operationId: job.operationId, status: parsed.value.status });
      jobs.set(key, { ...job, status: parsed.value.status });
      return success({ value: undefined });
    },
  };
}
function existingJob(required: { existing: CampaignJob; input: Pick<CampaignJob, "argumentsDigest" | "intent"> }) {
  if (required.existing.argumentsDigest !== required.input.argumentsDigest || digest({ value: required.existing.intent }) !== digest({ value: required.input.intent })) return fail<{ readonly jobId: string }>({ code: "conflict", message: "Operation identity reused with changed intent" });
  return success({ value: { jobId: required.existing.jobId } });
}
