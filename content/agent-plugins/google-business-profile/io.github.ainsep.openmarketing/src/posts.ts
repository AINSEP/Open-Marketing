/** One owner-approved text Update; no retries after a possibly submitted POST. */
import { z } from "zod";
import { capabilityCatalog, idSchema, pluginConfigurationSchema } from "@open-marketing/contracts";
import type { CallOptions, CapabilityOutput, Outcome, PluginCapability, PluginCapabilityDependencies } from "@open-marketing/contracts";
import { contextSchema, credentialSchema } from "./schemas.ts";
import { failure, readBody, responseFailure } from "./transport.ts";

const parentSchema = z.string().regex(/^accounts\/[0-9]{1,30}\/locations\/[0-9]{1,30}$/);
const publishSchema = z.strictObject({ context: contextSchema,
  connection: pluginConfigurationSchema.pick({ connectionId: true, accountId: true }), input: capabilityCatalog["organic.publish.v1"].input });
const receiptSchema = z.object({ name: idSchema, state: z.string().min(1).max(100), searchUrl: z.unknown().optional() });
type Publication = CapabilityOutput<"organic.publish.v1">;
type PublishCall = Parameters<PluginCapability<"organic.publish.v1">>[0];

/** Bind injected effects without I/O. Calls validate binding before accessing credentials.
 * @returns A single-call publisher with sanitized failures and explicit uncertain outcomes.
 * @complexity O(b) time/space per call, b <= 1 MiB; one POST, bounded by the host signal.
 * @example createPublishPost(dependencies)({ context, connection, input: { text: "An Update" } }, { signal })
 */
export function createPublishPost(required: PluginCapabilityDependencies): PluginCapability<"organic.publish.v1"> {
  return async (call, optional = {}) => {
    const configuration = pluginConfigurationSchema.safeParse(required.configuration);
    if (!configuration.success) return failure({ code: "forbidden", message: "GBP publish binding mismatch" });
    const binding = configuration.data;
    if (!matchesBinding({ binding, call })) return failure({ code: "forbidden", message: "GBP publish binding mismatch" });
    const parsed = publishSchema.safeParse(call);
    if (!parsed.success) return failure({ code: "invalid_input", message: "Invalid GBP publish input" });
    if (parsed.data.input.text.length > 1500) return failure({ code: "invalid_input", message: "GBP Updates are limited to 1500 characters" });
    const result = await publish({ dependencies: required, call: parsed.data }, optional);
    required.observer.observe({ operation: "google-business-profile.publish", outcome: result.ok ? result.value.status : result.error.code,
      correlationId: call.context.correlationId, traceId: call.context.traceId, ...("runId" in call.context ? { runId: call.context.runId } : {}) });
    return result;
  };
}

/** Compare only host binding fields; no credentials, discovery, or vendor account lookup. O(1). */
function matchesBinding({ binding, call }: { binding: PluginCapabilityDependencies["configuration"]; call: PublishCall }): boolean {
  return parentSchema.safeParse(binding.accountId).success && call.connection?.connectionId === binding.connectionId
    && call.connection?.accountId === binding.accountId && call.context?.scope?.ownerId === binding.scope.ownerId
    && call.context?.scope?.workspaceId === binding.scope.workspaceId;
}

/** Credential/fetch exceptions are contained here; any post-submission uncertainty forbids retry.
 * O(b) bounded response memory; credentials live for this call only.
 */
async function publish({ dependencies, call }: { dependencies: PluginCapabilityDependencies; call: PublishCall }, optional: CallOptions): Promise<Outcome<Publication>> {
  const signal = optional.signal ?? new AbortController().signal;
  let sent = false;
  try {
    signal.throwIfAborted();
    const access = await dependencies.credentials.access(call.connection, { signal });
    signal.throwIfAborted();
    if (!access.ok) return failure({ code: access.error.code, message: "GBP credentials unavailable; reconnect" });
    const token = credentialSchema.shape.accessToken.safeParse(access.value.accessToken);
    if (!token.success) return failure({ code: "unauthenticated", message: "Invalid GBP credentials; reconnect" });
    const url = new URL(`https://mybusiness.googleapis.com/v4/${call.connection.accountId}/localPosts`);
    signal.throwIfAborted();
    sent = true;
    const response = await dependencies.fetch(url, { method: "POST", redirect: "error", signal,
      headers: { Authorization: `Bearer ${token.data}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ topicType: "STANDARD", summary: call.input.text, ...(call.input.languageCode ? { languageCode: call.input.languageCode } : {}) }) });
    return await readPublication({ response, url, accountId: call.connection.accountId, signal });
  } catch {
    if (sent) return { ok: true, value: { status: "unknown" } };
    if (signal.aborted) return failure({ code: "cancelled", message: "GBP publish cancelled" });
    return failure({ code: "unavailable", message: "GBP credentials unavailable; reconnect" });
  }
}

/** Definite HTTP rejections preserve transport mappings; all ambiguous receipts stay unknown.
 * O(b) time/space via the existing 1 MiB reader. Rejected bodies are cancelled, never echoed.
 */
async function readPublication({ response, url, accountId, signal }: { response: Response; url: URL; accountId: string; signal: AbortSignal }): Promise<Outcome<Publication>> {
  const rejected = responseFailure({ response, url });
  if (rejected) {
    void response.body?.cancel().catch(() => {});
    if (response.status >= 500) return { ok: true, value: { status: "unknown" } };
    if (response.status === 400) return failure({ code: "invalid_input", message: "GBP rejected the Update" });
    return rejected;
  }
  const body = await readBody({ response, signal });
  if (!body.ok) return { ok: true, value: { status: "unknown" } };
  return { ok: true, value: publicationReceipt({ body: body.value, accountId }) };
}

/** Validate the resource parent before exposing any receipt fields. O(b), bounded by the reader. */
function publicationReceipt({ body, accountId }: { body: unknown; accountId: string }): Publication {
  const receipt = receiptSchema.safeParse(body);
  if (!receipt.success) return { status: "unknown" };
  const prefix = `${accountId}/localPosts/`;
  if (!receipt.data.name.startsWith(prefix) || receipt.data.name.length === prefix.length) return { status: "unknown" };
  let status: Publication["status"] = "unknown";
  switch (receipt.data.state) {
    case "LIVE": status = "published"; break;
    case "PROCESSING": status = "processing"; break;
    case "REJECTED": status = "rejected"; break;
  }
  const url = capabilityCatalog["organic.publish.v1"].output.shape.url.safeParse(receipt.data.searchUrl);
  return { status, postId: receipt.data.name, ...(url.success && url.data ? { url: url.data } : {}) };
}
