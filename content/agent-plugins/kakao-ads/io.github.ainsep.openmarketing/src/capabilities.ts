/** Canonical campaign reads. Reporting fails closed until cost currency/units are verified. */
import { z } from "zod";
import { callContextSchema, capabilityCatalog, campaignStatusOutputSchema, epochSchema, idSchema, pluginConfigurationSchema, serviceContextSchema } from "@open-marketing/contracts";
import type { AppError, CallOptions, CampaignStatusOutput, Outcome, PluginCapability, PluginCapabilityDependencies } from "@open-marketing/contracts";
import { checkCredential, requestKakaoRead } from "./transport.js";


type Call = Parameters<PluginCapability<"campaign.status.v1">>[0];
const vendorId = z.string().regex(/^[1-9]\d{0,18}$/);
const providerId = z.union([vendorId, z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String)]);
const configurationSchema = pluginConfigurationSchema.extend({ accountId: vendorId });
const envelope = z.strictObject({ context: z.union([callContextSchema, serviceContextSchema]), connection: z.strictObject({ connectionId: idSchema, accountId: vendorId }), input: capabilityCatalog["campaign.status.v1"].input });
const campaign = z.object({ id: providerId, adAccountId: providerId, config: idSchema, systemConfig: idSchema, isDailyBudgetAmountOver: z.boolean(), status: z.array(idSchema).max(32) });
/** No I/O at construction; only verified status reads are exposed.
 * @example createCapabilities({ configuration, credentials, fetch, clock, observer, wait })
 * @complexity Status O(n) time/space, <=100 IDs, up to 100 sequential GETs under a 25s pre-issue budget and caller deadline; no retries. */
export function createCapabilities(required: PluginCapabilityDependencies) {
  const dependencies = { ...required };
  return { "campaign.status.v1": (call: Call, options?: CallOptions) => invoke({ dependencies, call }, options) };
}
/** Preserve owner or service contexts verbatim; never manufacture an owner principal. */
async function invoke(required: { dependencies: PluginCapabilityDependencies; call: Call }, optional?: CallOptions): Promise<Outcome<CampaignStatusOutput>> {
  try {
    if (optional?.signal?.aborted) return failure({ code: "cancelled" });
    const prepared = prepare(required);
    if (!prepared.ok) return prepared;
    const { call, dependencies } = prepared.value;
    const result = await readStatuses({ dependencies, call, ids: call.input.vendorCampaignIds }, optional);
    observe({ dependencies, call, result });
    return result;
  } catch { return failure({ code: "unavailable" }); }
}
/** Parse the shared configuration and closed catalog call before credential access. */
function prepare(required: { dependencies: PluginCapabilityDependencies; call: Call }): Outcome<{ dependencies: PluginCapabilityDependencies; call: Call }> {
  const parsed = envelope.safeParse(required.call);
  const config = configurationSchema.safeParse(required.dependencies.configuration);
  if (!parsed.success || !config.success) return failure({ code: "invalid_input" });
  const call = parsed.data;
  const binding = config.data;
  if (call.connection.connectionId !== binding.connectionId || call.connection.accountId !== binding.accountId || call.context.scope.ownerId !== binding.scope.ownerId || call.context.scope.workspaceId !== binding.scope.workspaceId) return failure({ code: "forbidden" });
  return { ok: true, value: { dependencies: { ...required.dependencies, configuration: binding }, call } };
}
/** Fixed account-scoped detail reads expose no guessed creative-level rejection reasons. */
async function readStatuses(required: { dependencies: PluginCapabilityDependencies; call: Call; ids: string[] }, optional?: CallOptions): Promise<Outcome<CampaignStatusOutput>> {
  if (!z.array(vendorId).safeParse(required.ids).success) return failure({ code: "invalid_input" });
  const deadline = required.dependencies.clock.now({}) + 25000;
  const credential = await required.dependencies.credentials.access(required.call.connection, optional);
  if (!credential.ok) return failure({ code: credential.error.code });
  const campaigns: CampaignStatusOutput["campaigns"] = required.ids.map(vendorCampaignId => ({ vendorCampaignId, status: "unknown", disapprovalDescriptions: [] }));
  for (const value of campaigns) {
    const now = required.dependencies.clock.now({});
    if (now >= deadline) break;
    const token = checkCredential({ input: credential.value, now });
    if (!token.ok) return token;
    const response = await readCampaign({ ...required, id: value.vendorCampaignId, token: token.value, now }, optional);
    if (!response.ok) return response;
    value.status = response.value ?? "unknown";
  }
  return { ok: true, value: campaignStatusOutputSchema.parse({ observedAt: required.dependencies.clock.now({}), complete: campaigns.every(value => value.status !== "unknown"), campaigns }) };
}
/** Foreign or malformed entities reject the invocation; a missing requested ID stays unknown. */
function decodeCampaign(required: { status: number; body: unknown; id: string; accountId: string }): Outcome<CampaignStatusOutput["campaigns"][number]["status"] | null> {
  if (required.status === 404) return { ok: true, value: null };
  const item = campaign.safeParse(required.body);
  if (!item.success || item.data.id !== required.id) return failure({ code: "protocol_mismatch" });
  if (item.data.adAccountId !== required.accountId) return failure({ code: "forbidden" });
  return { ok: true, value: campaignState({ item: item.data }) };
}
/** Send a call-scoped token; the server guarded fetch owns current authority. */
async function readCampaign(required: { dependencies: PluginCapabilityDependencies; call: Call; id: string; token: string; now: number }, optional?: CallOptions): Promise<Outcome<CampaignStatusOutput["campaigns"][number]["status"] | null>> {
  const { dependencies } = required;
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  if (!epochSchema.safeParse(required.now).success) return failure({ code: "invalid_input" });
  const response = await requestKakaoRead({ dependencies, token: required.token, request: { url: "https://apis.moment.kakao.com/openapi/v4/campaigns/" + required.id, accountId: required.call.connection.accountId } }, optional);
  return response.ok ? decodeCampaign({ ...response.value, id: required.id, accountId: required.call.connection.accountId }) : response;
}
/** Config ON is not serving proof; only the documented unambiguous LIVE state maps to active. */
function campaignState({ item }: { item: z.infer<typeof campaign> }): CampaignStatusOutput["campaigns"][number]["status"] {
  if (item.config === "DEL" || item.status.some(value => ["FINISHED", "DELETED", "CANCELED"].includes(value))) return "ended";
  if (item.config === "OFF" || item.status.some(value => ["OFF", "PAUSED"].includes(value))) return "paused";
  if (item.status.length !== 1) return "unknown";
  if (item.config === "ON" && item.systemConfig === "ON" && !item.isDailyBudgetAmountOver && item.status[0] === "LIVE") return "active";
  if (item.status[0] === "READY") return "pending";
  return "unknown";
}
function failure({ code }: { code: AppError["code"] }): Outcome<never> { return { ok: false, error: { code, message: "Kakao capability " + code, retryable: false } }; }
function observe(required: { dependencies: PluginCapabilityDependencies; call: Call; result: Outcome<unknown> }): void {
  const context = required.call.context;
  try { required.dependencies.observer.observe({ operation: "kakao-ads.campaign.status.v1", outcome: required.result.ok ? "succeeded" : required.result.error.code, correlationId: context.correlationId, traceId: context.traceId, ...("runId" in context ? { runId: context.runId } : {}) }); }
  catch { /* Host audit remains authoritative. */ }
}
