import { z } from "zod";
import type { CallOptions, ClockPort, Outcome } from "@open-marketing/contracts";
import { boundedJson, failure, isUncertainFailure } from "./boundary.js";
import { vendorIdSchema } from "./commands.js";
import type { InstagramGraphCall, MetaInstagramPost, MetaInstagramPublishResult, MetaInstagramWait } from "./instagram-post.js";

const statusSchema = z.object({ status_code: z.enum(["EXPIRED", "ERROR", "FINISHED", "IN_PROGRESS", "PUBLISHED"]) });
type ContainerStatus = z.infer<typeof statusSchema>;
const quotaSchema = z.object({ data: z.tuple([z.object({ quota_usage: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), config: z.object({ quota_total: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), quota_duration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }) })]) });
const receiptSchema = z.object({ id: vendorIdSchema });
interface Publishing { post: MetaInstagramPost; call: InstagramGraphCall; clock: ClockPort; wait: MetaInstagramWait; deadline: number }

/** Parse provider objects under a byte cap; unexpected output is a protocol failure, never echoed.
 * @complexity O(n) time/space, <=64KiB.
 */
export function decodeInstagramResponse<T>(required: { input: unknown; schema: z.ZodType<T> }): Outcome<T> {
  const bounded = boundedJson({ input: required.input, maxBytes: 65536 });
  if (!bounded.ok) return failure({ code: "protocol_mismatch", message: "Invalid Instagram response" });
  const result = required.schema.safeParse(bounded.value);
  if (!result.success) return failure({ code: "protocol_mismatch", message: "Invalid Instagram response" });
  return { ok: true, value: result.data };
}

/** One approved post, sequential creation and bounded polling. Resuming never recreates a container.
 * @returns Published/processing/unknown or explicit quota/terminal/policy failure. No write retries.
 * @complexity O(k) sequential children, k<=10; <=5 checks/container and one shared five-minute deadline.
 */
export async function publishInstagramPost(required: Omit<Publishing, "deadline">, optional?: CallOptions): Promise<Outcome<MetaInstagramPublishResult>> {
  const publishing = { ...required, deadline: required.clock.now({}) + 300000 };
  const created = await createPostContainer(publishing, optional);
  if (!created.ok) return uncertainWrite({ result: created });
  const containerId = created.value;
  const ready = await pollContainer({ publishing, containerId }, optional);
  if (!ready.ok) return ready;
  const decision = publicationDecision({ containerId, container: ready.value });
  if (!decision.ok) return decision;
  if (decision.value !== null) return { ok: true, value: decision.value };
  const quota = await readInstagramQuota({ call: required.call, igUserId: required.post.igUserId });
  if (!quota.ok) return quota;
  if (quota.value.quota_usage >= quota.value.config.quota_total) return failure({ code: "limit_exceeded", message: "Instagram publishing quota exhausted" });
  return publishReadyContainer({ publishing, containerId }, optional);
}

/** Read status without exposing provider status/error text. @complexity One bounded GET. */
export async function readInstagramStatus(required: { call: InstagramGraphCall; containerId: string }): Promise<Outcome<ContainerStatus>> {
  const result = await required.call({ method: "GET", path: required.containerId, parameters: { fields: "status_code,status" } });
  if (!result.ok) return result;
  return decodeInstagramResponse({ input: result.value, schema: statusSchema });
}

/** Read the account's returned quota configuration; no hardcoded 50/100 assumption. @complexity One bounded GET. */
export async function readInstagramQuota(required: { call: InstagramGraphCall; igUserId: string }): Promise<Outcome<z.infer<typeof quotaSchema>["data"][0]>> {
  const result = await required.call({ method: "GET", path: `${required.igUserId}/content_publishing_limit`, parameters: { fields: "quota_usage,config{quota_total,quota_duration}" } });
  if (!result.ok) return result;
  const parsed = decodeInstagramResponse({ input: result.value, schema: quotaSchema });
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value.data[0] };
}

/** Captions go on the single/Reel/parent only; preserve carousel child order. @complexity O(k), k<=10. */
async function createPostContainer(required: Publishing, optional?: CallOptions): Promise<Outcome<string>> {
  const { post, call } = required;
  switch (post.kind) {
    case "resume": return { ok: true, value: post.containerId };
    case "image": return createContainer({ call, igUserId: post.igUserId, parameters: { image_url: post.imageUrl, caption: post.caption } });
    case "reel": return createContainer({ call, igUserId: post.igUserId, parameters: { video_url: post.videoUrl, media_type: "REELS", caption: post.caption } });
    case "carousel": {
      const children = await createCarouselChildren({ ...required, post }, optional);
      if (!children.ok) return children;
      return createContainer({ call, igUserId: post.igUserId, parameters: { media_type: "CAROUSEL", children: children.value.join(","), caption: post.caption } });
    }
    default: { const exhaustive: never = post; return exhaustive; }
  }
}

/** Stop on the first failed/pending child. Never expose a child as a resumable parent post.
 * @complexity <=10 sequential POSTs with bounded status checks; no partial batch publication.
 */
async function createCarouselChildren(required: Publishing & { post: Extract<MetaInstagramPost, { kind: "carousel" }> }, optional?: CallOptions): Promise<Outcome<string[]>> {
  const children: string[] = [];
  for (const item of required.post.items) {
    const parameters: Readonly<Record<string, string | boolean>> = "imageUrl" in item ? { image_url: item.imageUrl, is_carousel_item: true } : { video_url: item.videoUrl, media_type: "VIDEO", is_carousel_item: true };
    const child = await createContainer({ call: required.call, igUserId: required.post.igUserId, parameters });
    if (!child.ok) return child;
    const ready = await pollContainer({ publishing: required, containerId: child.value }, optional);
    if (!ready.ok) return ready;
    if (ready.value.status_code !== "FINISHED") return childFailure({ container: ready.value });
    children.push(child.value);
  }
  return { ok: true, value: children };
}

/** Child processing timeout leaves only unpublished, expiring containers; no automatic restart. @complexity O(1). */
function childFailure(required: { container: ContainerStatus }): Outcome<never> {
  if (required.container.status_code === "IN_PROGRESS") return failure({ code: "unavailable", message: "Instagram carousel child still processing; no parent was created. Do not publish a child directly." });
  if (required.container.status_code === "EXPIRED") return failure({ code: "expired", message: "Instagram carousel child expired" });
  return failure({ code: "conflict", message: "Instagram carousel child is not publishable" });
}

/** A malformed or lost creation receipt stops the flow; containers are never blindly recreated. @complexity One POST. */
async function createContainer(required: { call: InstagramGraphCall; igUserId: string; parameters: Readonly<Record<string, string | boolean>> }): Promise<Outcome<string>> {
  const result = await required.call({ method: "POST", path: `${required.igUserId}/media`, parameters: required.parameters });
  if (!result.ok) return result;
  const parsed = decodeInstagramResponse({ input: result.value, schema: receiptSchema });
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value.id };
}

/** At most five status reads, separated by 60s. All children/parent share one five-minute deadline.
 * @complexity O(1) bounded calls; wait is injected and cancellation-aware, no timers start on import.
 */
async function pollContainer(required: { publishing: Publishing; containerId: string }, optional?: CallOptions): Promise<Outcome<ContainerStatus>> {
  const { publishing, containerId } = required;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (publishing.clock.now({}) >= publishing.deadline) break;
    const result = await readInstagramStatus({ call: publishing.call, containerId });
    if (!result.ok || result.value.status_code !== "IN_PROGRESS") return result;
    const waited = await waitBeforeNextCheck({ publishing, attempt }, optional);
    if (!waited.ok) return waited;
    if (!waited.value) break;
  }
  return { ok: true, value: { status_code: "IN_PROGRESS" } };
}

/** Wait only when another one-minute check fits the shared deadline; catch timer adapter failures.
 * @complexity O(1), one injected cancellable wait.
 */
async function waitBeforeNextCheck(required: { publishing: Publishing; attempt: number }, optional?: CallOptions): Promise<Outcome<boolean>> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Instagram polling cancelled" });
  if (required.attempt === 4 || required.publishing.clock.now({}) + 60000 >= required.publishing.deadline) return { ok: true, value: false };
  let waited: Outcome<void>;
  try { waited = await required.publishing.wait({ milliseconds: 60000 }, optional); }
  catch { return failure({ code: "unavailable", message: "Instagram polling wait unavailable" }); }
  if (!waited.ok) return waited;
  return { ok: true, value: true };
}

/** Only FINISHED admits publication; PUBLISHED is already complete even with no media ID. @complexity O(1). */
function publicationDecision(required: { containerId: string; container: ContainerStatus }): Outcome<MetaInstagramPublishResult | null> {
  switch (required.container.status_code) {
    case "FINISHED": return { ok: true, value: null };
    case "IN_PROGRESS": return { ok: true, value: { status: "processing", containerId: required.containerId } };
    case "PUBLISHED": return { ok: true, value: { status: "published" } };
    case "EXPIRED": return failure({ code: "expired", message: "Instagram container expired" });
    case "ERROR": return failure({ code: "conflict", message: "Instagram container processing failed" });
    default: { const exhaustive: never = required.container.status_code; return exhaustive; }
  }
}

/** Recheck status after quota, immediately before publishing. One status reconciliation on a lost ACK.
 * @complexity <=1 POST + 2 GETs. The server's outbox owns replay/uncertain-operation suppression.
 */
async function publishReadyContainer(required: { publishing: Publishing; containerId: string }, optional?: CallOptions): Promise<Outcome<MetaInstagramPublishResult>> {
  const { publishing, containerId } = required;
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Instagram publishing cancelled" });
  if (publishing.clock.now({}) >= publishing.deadline) return { ok: true, value: { status: "processing", containerId } };
  const status = await readInstagramStatus({ call: publishing.call, containerId });
  if (!status.ok) return status;
  const decision = publicationDecision({ containerId, container: status.value });
  if (!decision.ok) return decision;
  if (decision.value !== null) return { ok: true, value: decision.value };
  if (publishing.clock.now({}) >= publishing.deadline) return { ok: true, value: { status: "processing", containerId } };
  return sendPublication(required);
}

/** Lost or malformed publish receipt gets exactly one read; no second POST. @complexity <=1 POST + 1 GET. */
async function sendPublication(required: { publishing: Publishing; containerId: string }): Promise<Outcome<MetaInstagramPublishResult>> {
  const { publishing, containerId } = required;
  const result = await publishing.call({ method: "POST", path: `${publishing.post.igUserId}/media_publish`, parameters: { creation_id: containerId } });
  if (!result.ok && !isUncertainFailure({ error: result.error })) return result;
  if (result.ok) {
    const receipt = decodeInstagramResponse({ input: result.value, schema: receiptSchema });
    if (receipt.ok) return { ok: true, value: { status: "published", mediaId: receipt.value.id } };
  }
  const reconciled = await readInstagramStatus({ call: publishing.call, containerId });
  if (reconciled.ok && reconciled.value.status_code === "PUBLISHED") return { ok: true, value: { status: "published" } };
  return { ok: true, value: { status: "unknown", containerId } };
}

/** Only a typed refusal proves a creation didn't proceed. @complexity O(1). */
function uncertainWrite(required: { result: Extract<Outcome<unknown>, { ok: false }> }): Outcome<MetaInstagramPublishResult> {
  if (isUncertainFailure({ error: required.result.error })) return { ok: true, value: { status: "unknown" } };
  return required.result;
}
