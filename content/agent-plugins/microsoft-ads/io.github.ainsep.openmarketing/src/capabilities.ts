import { unzipSync } from "fflate";
import { z } from "zod";
import { callContextSchema, pluginConfigurationSchema, reportMetricsInputSchema, serviceContextSchema } from "@open-marketing/contracts";
import type { AppError, CallOptions, MetricBatch, Outcome, PluginCapabilities, PluginCapabilitiesFactory, PluginCapability, PluginCapabilityDependencies } from "@open-marketing/contracts";
import { request, vendorIdSchema } from "./commands.js";
import { failure } from "./ports.js";
import type { MicrosoftAdsArchiveReader, MicrosoftAdsWireRequest } from "./ports.js";
import { runMetricsReport } from "./reporting.js";
import { pluginCredentialSchema, postMicrosoftAds, readBounded } from "./transport.js";

const configurationSchema = pluginConfigurationSchema.extend({ accountId: vendorIdSchema });
const callSchema = z.object({
  context: z.union([callContextSchema, serviceContextSchema]),
  connection: z.strictObject({ connectionId: pluginConfigurationSchema.shape.connectionId, accountId: vendorIdSchema }),
  input: reportMetricsInputSchema,
});
const canonicalCredentialSchema = pluginCredentialSchema.extend({ customerId: vendorIdSchema.optional() });
const accountIdSchema = z.union([vendorIdSchema, z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String)]);
const accountSchema = z.object({ Account: z.object({ Id: accountIdSchema, ParentCustomerId: accountIdSchema, CurrencyCode: z.string().regex(/^[A-Z]{3}$/) }) });
type MetricsCall = Parameters<PluginCapability<"report.metrics.v1">>[0];
type Binding = z.infer<typeof configurationSchema>;

/** Inert canonical metrics factory; the server owns admission and guards every injected effect.
 * @returns Only report.metrics.v1; each call resolves fresh credentials and account facts.
 * @example createCapabilities({ configuration, credentials, fetch, clock, wait, observer })
 * @complexity O(1) construction; handler limits are 25s, 2MiB ZIP and 8MiB expanded data.
 */
export const createCapabilities = ((required: PluginCapabilityDependencies): PluginCapabilities => ({
  "report.metrics.v1": (call, options) => reportMetrics({ dependencies: required, call }, options),
})) satisfies PluginCapabilitiesFactory;

/** Parse and bind the canonical envelope before credentials or network I/O. O(1), no effects. */
function prepareMetrics(required: { dependencies: PluginCapabilityDependencies; call: MetricsCall }): Outcome<{ configuration: Binding; call: z.infer<typeof callSchema> }> {
  const configuration = configurationSchema.safeParse(required.dependencies.configuration);
  const call = callSchema.safeParse(required.call);
  if (!configuration.success || !call.success) return failure({ code: "invalid_input" });
  const config = configuration.data;
  if (call.data.connection.connectionId !== config.connectionId || call.data.connection.accountId !== config.accountId
    || call.data.context.scope.ownerId !== config.scope.ownerId || call.data.context.scope.workspaceId !== config.scope.workspaceId) return failure({ code: "forbidden" });
  return { ok: true, value: { configuration: config, call: call.data } };
}

/** Account lookup and the existing reporting workflow share one deadline; thrown vendor/codec
 * failures become static typed errors. No credential or account facts survive this call.
 * @complexity One account lookup plus <=7 report RPCs; O(b+n), <=8MiB and 5,000 rows.
 */
async function reportMetrics(required: { dependencies: PluginCapabilityDependencies; call: MetricsCall }, optional?: CallOptions): Promise<Outcome<MetricBatch>> {
  const signal = AbortSignal.any([AbortSignal.timeout(25000), ...(optional?.signal ? [optional.signal] : [])]);
  try {
    if (signal.aborted) return failure({ code: "cancelled" });
    const prepared = prepareMetrics(required);
    if (!prepared.ok) return prepared;
    const { configuration, call } = prepared.value;
    const { dependencies } = required;
    let customerId: string | undefined;
    const rpc = (input: { request: MicrosoftAdsWireRequest }) => canonicalRpc({ dependencies, configuration, request: input.request, customerId, signal });
    const response = await rpc({ request: request({ service: "CustomerManagement", path: "Account/Query", body: { AccountId: configuration.accountId } }) });
    if (!response.ok) return response;
    const account = accountSchema.safeParse(response.value);
    if (!account.success) return failure({ code: "protocol_mismatch" });
    if (account.data.Account.Id !== configuration.accountId) return failure({ code: "forbidden" });
    customerId = account.data.Account.ParentCustomerId;
    const result = await runMetricsReport({
      dependencies: { configuration: { connectionId: configuration.connectionId, accountId: configuration.accountId, currency: account.data.Account.CurrencyCode }, clock: dependencies.clock, wait: dependencies.wait, archiveReader },
      input: call.input, rpc,
      download: input => downloadReport({ dependencies, url: input.url, maxBytes: input.maxBytes, signal }),
    }, { ...optional, signal });
    if (signal.aborted) return failure({ code: interruption({ signal, caller: optional?.signal }) });
    return result;
  } catch { return failure({ code: interruption({ signal, caller: optional?.signal }) }); }
}

/** Static error classification never inspects a thrown provider or credential value. */
function interruption(required: { signal: AbortSignal; caller?: AbortSignal }): AppError["code"] {
  if (required.caller?.aborted) return "cancelled";
  return required.signal.aborted ? "expired" : "unavailable";
}

/** Recheck the bound credential once per RPC; both tokens stay in headers, never errors.
 * CustomerManagement omits CustomerId; subsequent RPCs prefer the credential's agency override.
 * @complexity O(1) credential validation and one bounded JSON POST, no retries.
 */
export async function canonicalRpc(required: { dependencies: PluginCapabilityDependencies; configuration: Binding; request: MicrosoftAdsWireRequest; customerId?: string; signal: AbortSignal }): Promise<Outcome<unknown>> {
  const { dependencies, configuration, signal } = required;
  if (signal.aborted) return failure({ code: "expired" });
  const credential = await resolveCanonicalCredential({ dependencies, configuration, signal });
  if (!credential.ok) return credential;
  if (signal.aborted) return failure({ code: "expired" });
  const customerId = required.customerId === undefined ? undefined : credential.value.customerId ?? required.customerId;
  const result = await postMicrosoftAds({ fetch: dependencies.fetch, request: required.request, accessToken: credential.value.accessToken, developerToken: credential.value.secrets.developerToken, accountId: configuration.accountId, customerId, signal });
  return result.ok ? result : failure({ code: result.error.code });
}

/** Parse both tokens and expiry after each bound lookup; tainted failures lose their text. O(1). */
async function resolveCanonicalCredential(required: { dependencies: PluginCapabilityDependencies; configuration: Binding; signal: AbortSignal }): Promise<Outcome<z.infer<typeof canonicalCredentialSchema>>> {
  const { dependencies, configuration, signal } = required;
  const credential = await dependencies.credentials.access({ connectionId: configuration.connectionId, accountId: configuration.accountId }, { signal });
  if (!credential.ok) return failure({ code: credential.error.code });
  const parsed = canonicalCredentialSchema.safeParse(credential.value);
  if (!parsed.success) return failure({ code: "unauthenticated" });
  const now = dependencies.clock.now({});
  if (!Number.isSafeInteger(now) || now < 0) return failure({ code: "invalid_input" });
  if (parsed.data.expiresAt !== undefined && parsed.data.expiresAt <= now) return failure({ code: "expired" });
  return { ok: true, value: parsed.data };
}

/** URL validation stays in the existing reporting workflow; signed downloads receive no auth.
 * @complexity One guarded GET, O(b<=2MiB) time/space; no redirects or retries.
 */
async function downloadReport(required: { dependencies: PluginCapabilityDependencies; url: string; maxBytes: number; signal: AbortSignal }): Promise<Outcome<Uint8Array>> {
  const response = await required.dependencies.fetch(required.url, { method: "GET", redirect: "error", signal: required.signal });
  if (response.status !== 200) { await response.body?.cancel(); return failure({ code: "unavailable" }); }
  return readBounded({ response, maxBytes: required.maxBytes });
}

/** Single-entry ZIP adapter for the existing archive port. fflate's filter runs before inflate;
 * reject extra/oversized entries before allocating their expanded data. Existing reporting code
 * checks the filename, actual bytes and UTF-8. O(b) time/space, b<=8MiB.
 */
const archiveReader: MicrosoftAdsArchiveReader = {
  async *entries({ archive }) {
    let entries = 0;
    const files = unzipSync(archive, { filter: file => {
      entries += 1;
      if (entries !== 1 || file.originalSize > 8388608) throw new Error("Invalid Microsoft report archive");
      return true;
    } });
    if (entries !== 1) throw new Error("Invalid Microsoft report archive");
    const [entryPath, bytes] = Object.entries(files)[0];
    yield { kind: "file", entryPath, declaredSize: bytes.byteLength, async *openReadStream() { yield bytes; } };
  },
};
