import { z } from "zod";
import { callContextSchema, idSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, ClockPort, EffectEnvelope, ObserverPort, Outcome } from "@open-marketing/contracts";
import { boundedJson, digest, failure, parse } from "./boundary.js";
import { vendorIdSchema } from "./commands.js";
import { decodeInstagramResponse, publishInstagramPost, readInstagramQuota, readInstagramStatus } from "./instagram-publish.js";
import { localMediaMessage, metaInstagramPostSchema } from "./instagram-post.js";
import type { InstagramGraphCall, MetaInstagramPublishResult, MetaInstagramWait } from "./instagram-post.js";

export { metaInstagramPostSchema } from "./instagram-post.js";
export type { InstagramGraphCall, MetaInstagramPost, MetaInstagramPublishResult, MetaInstagramWait } from "./instagram-post.js";

const accountsInput = z.strictObject({});
const statusInput = z.strictObject({ igUserId: vendorIdSchema, containerId: vendorIdSchema });
const insightsInput = z.strictObject({ mediaId: vendorIdSchema });
export const metaInstagramCommandSchema = z.discriminatedUnion("kind", [
  accountsInput.extend({ kind: z.literal("instagram_accounts") }),
  z.strictObject({ kind: z.literal("instagram_publish_post"), post: metaInstagramPostSchema }),
  statusInput.extend({ kind: z.literal("instagram_post_status") }),
  insightsInput.extend({ kind: z.literal("instagram_media_insights") }),
]);
const requestSchema = z.strictObject({ context: callContextSchema, connectionId: idSchema, operationId: idSchema, command: metaInstagramCommandSchema });
const configurationSchema = z.strictObject({ apiVersion: z.string().regex(/^v[1-9][0-9]{0,2}\.[0-9]{1,2}$/), timeoutMs: z.number().int().min(1).max(15000) });
export type MetaInstagramRequest = z.infer<typeof requestSchema>;
export type MetaInstagramConfiguration = z.infer<typeof configurationSchema>;
export interface MetaInstagramGraphRequest { readonly method: "GET" | "POST"; readonly endpoint: string; readonly parameters: Readonly<Record<string, string | boolean>> }

/** Server-owned policy + credentialed egress. Bind this callback to the frozen full tool invocation,
 * use operationId as the ONE outbox key, and recheck current authority after resolving credentials
 * at EVERY Graph call. Subcalls share that approved job; they do not enqueue separate approvals.
 * Bound HTTP/response bytes; never redirect credentials, retry POSTs, or return provider secrets.
 */
export type MetaInstagramDispatch = (required: { context: CallContext; connectionId: string; operationId: string; effect: EffectEnvelope; request: MetaInstagramGraphRequest; timeoutMs: number }, optional?: CallOptions) => Promise<Outcome<unknown>>;

const accountsSchema = z.object({ data: z.array(z.object({ id: vendorIdSchema, name: z.string().max(256), instagram_business_account: z.object({ id: vendorIdSchema, username: z.string().max(256).optional() }).nullish() })).max(100), paging: z.object({ next: z.string().max(8192).optional() }).optional() });
const insightsSchema = z.object({ data: z.array(z.object({ name: z.enum(["reach", "views", "total_interactions"]), period: z.string().max(64), values: z.array(z.object({ value: z.number().finite().nonnegative(), end_time: z.string().max(64).optional() })).max(100) })).max(3) });
export type MetaInstagramResult = MetaInstagramPublishResult
  | { accounts: readonly { pageId: string; pageName: string; igUserId: string; username?: string }[]; hasMore: boolean }
  | { container: { status_code: "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED" }; quota: { quota_usage: number; config: { quota_total: number; quota_duration: number } } }
  | { insights: z.infer<typeof insightsSchema>["data"] };

/** Plain definitions for the server/assistant ONE catalog; importing registers nothing. Input schemas
 * are the tool arguments (publish takes the post directly); the host adds context/connection/operation.
 */
export const metaInstagramTools = [
  { name: "instagram_accounts", description: "Discover Instagram professional accounts connected to Facebook Pages.", inputSchema: z.toJSONSchema(accountsInput), effects: ["read"] },
  { name: "instagram_publish_post", description: "Publish an image, ordered carousel or Reel with a caption; resume a known post container. No scheduling.", inputSchema: z.toJSONSchema(metaInstagramPostSchema), effects: ["write"] },
  { name: "instagram_post_status", description: "Read a container's processing status and the account's publishing quota.", inputSchema: z.toJSONSchema(statusInput), effects: ["read"] },
  { name: "instagram_media_insights", description: "Read reach, views and total interactions for Instagram media.", inputSchema: z.toJSONSchema(insightsInput), effects: ["read"] },
] as const;

interface Dependencies { request: MetaInstagramRequest; dispatch: MetaInstagramDispatch; clock: ClockPort; wait: MetaInstagramWait; observer: ObserverPort; configuration: MetaInstagramConfiguration }

/** Validate and invoke one organic Instagram tool. Captions/URLs never enter observer events.
 * @param required - Server context/configuration and injected guarded dispatch, clock, wait and observer.
 * @returns Explicit read/failure values or published/processing/unknown; never implicitly retries writes.
 * @example invokeMetaInstagram({ request, dispatch, clock, wait, observer, configuration })
 * @complexity O(n) bounded parsing; at most 10 sequential children and five-minute processing window.
 */
export async function invokeMetaInstagram(required: Dependencies, optional?: CallOptions): Promise<Outcome<MetaInstagramResult>> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Instagram call cancelled before dispatch" });
  const configuration = parse({ schema: configurationSchema, input: required.configuration });
  if (!configuration.ok) return configuration;
  const bounded = boundedJson({ input: required.request, maxBytes: 65536 });
  if (!bounded.ok) return bounded;
  const parsed = requestSchema.safeParse(bounded.value);
  if (!parsed.success) {
    const message = parsed.error.issues.some(issue => issue.message === localMediaMessage) ? localMediaMessage : "Invalid Instagram input; scheduling is unsupported";
    return failure({ code: "invalid_input", message });
  }
  const dependencies = { ...required, request: parsed.data, configuration: configuration.value };
  const call: InstagramGraphCall = graph => dispatchGraph({ dependencies, graph }, optional);
  return invokeCommand({ dependencies, call }, optional);
}

/** One credential-free request with the digest of the FULL reviewed post, not just creation_id.
 * Adapter throws become uncertainty at the publish layer. @complexity O(n) digest, one bounded call.
 */
async function dispatchGraph(required: { dependencies: Dependencies; graph: Parameters<InstagramGraphCall>[0] }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { dependencies, graph } = required;
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Instagram call cancelled before egress" });
  const { request, configuration } = dependencies;
  const command = request.command;
  const accountId = command.kind === "instagram_publish_post" ? command.post.igUserId : command.kind === "instagram_post_status" ? command.igUserId : null;
  const effect: EffectEnvelope = { operationId: request.operationId, connectionId: request.connectionId, accountId, effects: [graph.method === "POST" ? "write" : "read"], argumentsDigest: digest({ value: { command, apiVersion: configuration.apiVersion } }), moneyExposure: null, requiredLimit: null };
  let result: Outcome<unknown>;
  try {
    result = await dependencies.dispatch({ context: request.context, connectionId: request.connectionId, operationId: request.operationId, effect, request: { method: graph.method, endpoint: `https://graph.facebook.com/${configuration.apiVersion}/${graph.path}`, parameters: graph.parameters }, timeoutMs: configuration.timeoutMs }, optional);
  } catch { result = failure({ code: "unavailable", message: "Instagram dispatch acknowledgement unavailable" }); }
  try { dependencies.observer.observe({ operation: `meta-ads.instagram.${graph.method}`, outcome: result.ok ? "received" : result.error.code, correlationId: request.context.correlationId, traceId: request.context.traceId, runId: request.context.runId }); }
  catch { /* Durable server audit remains authoritative even when telemetry fails. */ }
  return result;
}

/** Coordinate the four closed tools; reads never synthesize missing metrics or quota. @complexity Bounded response traversal. */
async function invokeCommand(required: { dependencies: Dependencies; call: InstagramGraphCall }, optional?: CallOptions): Promise<Outcome<MetaInstagramResult>> {
  const { dependencies, call } = required;
  const command = dependencies.request.command;
  switch (command.kind) {
    case "instagram_publish_post": return publishInstagramPost({ post: command.post, call, clock: dependencies.clock, wait: dependencies.wait }, optional);
    case "instagram_accounts": return readAccounts({ call });
    case "instagram_post_status": return readPostStatus({ call, command });
    case "instagram_media_insights": return readMediaInsights({ call, mediaId: command.mediaId });
    default: { const exhaustive: never = command; return exhaustive; }
  }
}

/** Read <=100 Pages; omit unconnected Pages and credential-bearing pagination links. @complexity One GET + O(n), n<=100. */
async function readAccounts(required: { call: InstagramGraphCall }): Promise<Outcome<MetaInstagramResult>> {
  const response = await required.call({ method: "GET", path: "me/accounts", parameters: { fields: "id,name,instagram_business_account{id,username}", limit: "100" } });
  if (!response.ok) return response;
  const parsed = decodeInstagramResponse({ input: response.value, schema: accountsSchema });
  if (!parsed.ok) return parsed;
  const accounts = parsed.value.data.flatMap(page => page.instagram_business_account ? [{ pageId: page.id, pageName: page.name, igUserId: page.instagram_business_account.id, ...(page.instagram_business_account.username === undefined ? {} : { username: page.instagram_business_account.username }) }] : []);
  return { ok: true, value: { accounts, hasMore: parsed.value.paging?.next !== undefined } };
}

/** Status and quota are explicit independent reads, never inferred defaults. @complexity Two bounded GETs. */
async function readPostStatus(required: { call: InstagramGraphCall; command: z.infer<typeof statusInput> }): Promise<Outcome<MetaInstagramResult>> {
  const container = await readInstagramStatus({ call: required.call, containerId: required.command.containerId });
  if (!container.ok) return container;
  const quota = await readInstagramQuota({ call: required.call, igUserId: required.command.igUserId });
  if (!quota.ok) return quota;
  return { ok: true, value: { container: container.value, quota: quota.value } };
}

/** Request only supported basic metrics; unavailable values stay absent. @complexity One GET, <=3 metrics/100 values each. */
async function readMediaInsights(required: { call: InstagramGraphCall; mediaId: string }): Promise<Outcome<MetaInstagramResult>> {
  const response = await required.call({ method: "GET", path: `${required.mediaId}/insights`, parameters: { metric: "reach,views,total_interactions" } });
  if (!response.ok) return response;
  const parsed = decodeInstagramResponse({ input: response.value, schema: insightsSchema });
  if (!parsed.ok) return parsed;
  return { ok: true, value: { insights: parsed.value.data } };
}
