import { z } from "zod";
import { callContextSchema, campaignDeploymentReceiptSchema, campaignValidateInputSchema, definePluginTools, idSchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, CallOptions, CampaignDeploymentReceipt, CampaignDeploymentRequired, CampaignValidateOutput, EffectCategory, Outcome, PluginCapability, PluginCapabilityDependencies, PluginConfiguration, PluginTool, PluginToolInvocation, PluginToolsFactory } from "@open-marketing/contracts";
import { createGooglePlugin, prepareCreation } from "./plugin.ts";
import { addNegativeKeyword, negativeKeywordInputSchema } from "./negative-keywords.ts";
import { asRecord } from "./readback.ts";
import { digest, operationIdentity } from "./rules.ts";
import { failure, protect, success } from "./schema.ts";
import { campaignDeploymentPlanSchema, planSchema, toolInputSchemas } from "./schemas.ts";
import { createCallTransport, readAccount, readContext } from "./transport.ts";
import { searchTermsInputSchema, searchTermsReport } from "./search-terms.ts";
import type { AccountBinding, GoogleTransportPort, OperationJournalPort, OperationRecord, Receipt, SearchPlan, ToolName } from "./types.ts";

export const descriptions: Record<ToolName, string> = {
  list_accounts: "Read the one host-scoped Google account; never enumerates foreign accounts.",
  read_campaign: "Read the complete bounded Search hierarchy and status.", read_budget: "Read a non-shared average daily budget; it is not a hard daily cap.",
  report: "Read account-local served cost, clicks and impressions for at most 31 days.",
  create_paused: "Create one bounded Search hierarchy with all serving entities PAUSED.",
  activate: "Activate the exact reviewed controlled plan; requires current exact spend authority.",
  set_budget: "Change one average daily budget under a new exact spend approval.",
  pause: "Pause the specified controlled Search hierarchy with normal write authority.",
  reconcile: "Read back an uncertain operation; never blindly retries it.",
};

const unavailableReason = "NEEDS: Google durable controlled-plan journal and verified billing evidence";
const effects: Record<ToolName, EffectCategory[]> = {
  list_accounts: ["read"], read_campaign: ["read"], read_budget: ["read"], report: ["read"],
  create_paused: ["write"], activate: ["write", "ad_spend"], set_budget: ["write", "ad_spend"],
  pause: ["write"], reconcile: ["read"],
};
/** Fixed declarations and parser share closed Zod inputs; effects confer no authority. */
const defined = definePluginTools({ tools: [...Object.entries(toolInputSchemas).map(([name, inputSchema]) => ({
  name, description: descriptions[name as ToolName], inputSchema, effects: effects[name as ToolName],
  ...(["create_paused", "activate", "set_budget", "pause", "reconcile"].includes(name) ? { unavailableReason } : {}),
})),
{ name: "search_terms_report", description: "Read a campaign's top 50 reported search terms by served cost over at most 31 account-local days. Google omits some low-volume terms, so this report never represents total waste.", inputSchema: searchTermsInputSchema, effects: ["read"] },
{ name: "add_negative_keyword", description: "Add one EXACT negative keyword to a Search campaign or its ad group under a fresh exact Allow/Cancel card. Existing matches do not mutate; unknown outcomes require owner review before a separately approved precheck. Text: 1–80 characters, at most 10 words; quotes, backslash and Google operator characters are rejected.", inputSchema: negativeKeywordInputSchema, effects: ["write", "destructive"] },
] });
export const tools: PluginTool[] = defined.tools;
export const parseTool: (required: { name: string; input: unknown }) => Outcome<unknown> = defined.parseTool;
const extraTools: Record<string, (required: Parameters<typeof searchTermsReport>[0]) => Promise<Outcome<unknown>>> = {
  search_terms_report: searchTermsReport, add_negative_keyword: addNegativeKeyword,
};

/** Inert fixed tool ABI; resolve binding and credentials afresh for each host invocation.
 * Invalid, unavailable and foreign calls fail before credential reads or fetches.
 * @returns Bounded reads and exact-negative creation; unavailable legacy writes retain typed failures.
 * @example createTools({ configuration, credentials, fetch, clock, observer, wait }).invoke(call)
 * @complexity One metadata search plus the selected handler's bounded reads; no retries.
 */
export function createTools(required: PluginCapabilityDependencies): ReturnType<PluginToolsFactory> {
  return { invoke: (call, optional) => protect({ work: () => invokeTool({ dependencies: required, call }, optional) }) };
}

/** Validate the fixed ABI before per-call account lookup; operationId is host-owned. */
async function invokeTool({ dependencies, call }: { dependencies: PluginCapabilityDependencies; call: PluginToolInvocation }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const parsed = parseTool({ name: call.name, input: call.input });
  if (!parsed.ok) return parsed;
  const operationId = parseBoundary({ schema: idSchema, input: call.operationId });
  if (!operationId.ok) return operationId;
  const tool = tools.find(tool => tool.name === call.name)!;
  if (tool.unavailableReason) return unavailable();
  const configured = createCallTransport({ dependencies }, optional);
  if (!configured.ok) return configured;
  const context = parseBoundary({ schema: callContextSchema, input: call.context });
  if (!context.ok) return context;
  const { configuration, transport } = configured.value;
  if (context.value.scope.ownerId !== configuration.scope.ownerId || context.value.scope.workspaceId !== configuration.scope.workspaceId
    || call.connection.connectionId !== configuration.connectionId || call.connection.accountId !== configuration.accountId) return failure({ code: "forbidden", message: "Google tool binding mismatch" });
  const serviceContext = { ...context.value, principal: { kind: "service" as const, serviceId: "om-agent-plugin-backends" } };
  const binding = await accountBinding({ dependencies: { ...configured.value, clock: dependencies.clock }, context: serviceContext,
    mode: "read_only", schemaFingerprint: digest({ value: tool.inputSchema }) }, optional);
  if (!binding.ok) return binding;
  const extra = extraTools[call.name];
  // Extra writes rely on host mode gating; this read_only binding gates only legacy tools.
  if (extra) return extra({ binding: binding.value, transport, clock: dependencies.clock, context: serviceContext, operationId: operationId.value, input: parsed.value });
  const adapter = createGooglePlugin({ binding: binding.value, transport, clock: dependencies.clock,
    journal: { claim: unavailable, append: unavailable, get: unavailable, findCampaign: unavailable },
    authority: { dispatch: unavailable, billing: unavailable },
  });
  return adapter.invoke({ context: serviceContext, name: call.name, arguments: { ...parsed.value as Record<string, unknown>, operationId: operationId.value } });
}

/** Both callers validate identity before this one metadata read and binding projection.
 * Prepared dependencies preserve that ordering without constructing another transport.
 * @returns API-derived account facts or the existing typed metadata failure.
 * @complexity O(1) projection and one bounded customer search, no retained credentials.
 */
async function accountBinding(required: { dependencies: Parameters<typeof readAccount>[0]["dependencies"] & { configuration: PluginConfiguration }; context: CallContext; mode: AccountBinding["mode"]; schemaFingerprint: string }, optional?: CallOptions): Promise<Outcome<AccountBinding>> {
  const account = await readAccount(required, optional);
  if (!account.ok) return account;
  return success({ value: { ...required.dependencies.binding, currency: account.value.currencyCode, timezone: account.value.timeZone,
    mode: required.mode, pluginDigest: required.dependencies.configuration.pluginDigest, schemaFingerprint: required.schemaFingerprint } });
}

/** Deploy a paused Search campaign using the owning host job's durable checkpoints.
 * Existing saved claims return their receipt without resending. Sandbox accounts only.
 * @returns A paused receipt or typed boundary/checkpoint failure; no automatic retries.
 * @complexity One metadata read, at most one mutate, then fixed bounded hierarchy reads.
 * @example deployCampaignPaused({ context, operationId, plan, connectionId, accountId, dependencies, checkpoint, saved })
 */
export function deployCampaignPaused(required: CampaignDeploymentRequired, optional?: CallOptions): Promise<Outcome<CampaignDeploymentReceipt>> {
  return protect({ work: () => deployment({ required, mode: "sandbox" }, optional) });
}

/** Reconcile a saved Google journal using searches only; never resubmit creation.
 * @returns Paused receipt or typed failure; host checkpoints the observation.
 * @complexity One metadata lookup and a fixed number of bounded hierarchy searches.
 * @example readCampaignDeployment({ context, operationId, plan, connectionId, accountId, dependencies, checkpoint, saved })
 */
export function readCampaignDeployment(required: CampaignDeploymentRequired, optional?: CallOptions): Promise<Outcome<CampaignDeploymentReceipt>> {
  return protect({ work: () => deployment({ required, mode: "read_only" }, optional) });
}

/** Shared deployment/validation binding: closed plan and identity before metadata egress.
 * Returns typed boundary/account failures; one bounded metadata read, no retained credentials. */
async function deploymentBinding(input: { required: Pick<CampaignDeploymentRequired, "plan" | "dependencies" | "context" | "connectionId" | "accountId">; mode: "sandbox" | "read_only" }, optional?: CallOptions): Promise<Outcome<{ plan: SearchPlan; context: CallContext; binding: AccountBinding; transport: GoogleTransportPort }>> {
  const { required, mode } = input;
  const plan = parseBoundary({ schema: campaignDeploymentPlanSchema, input: required.plan });
  if (!plan.ok) return plan;
  const configured = createCallTransport({ dependencies: required.dependencies }, optional);
  if (!configured.ok) return configured;
  const { configuration, transport } = configured.value;
  if (required.connectionId !== configuration.connectionId || required.accountId !== configuration.accountId) return failure({ code: "forbidden", message: "Google deployment binding mismatch" });
  const context = { ...required.context, principal: { kind: "service" as const, serviceId: "om-campaign-deployment" } };
  const bound = await accountBinding({ dependencies: { ...configured.value, clock: required.dependencies.clock }, context, mode, schemaFingerprint: digest({ value: planSchema }) }, optional);
  if (!bound.ok) return bound;
  return success({ value: { plan: plan.value, context, binding: bound.value, transport } });
}

/** Vendor dry run of creation's exact atomic body, with sandbox account checks and no journal.
 * @returns Validated only for a parsed error-free response; provider failures remain typed.
 * @example validateCampaignDeployment({ dependencies, call }, { signal })
 * @complexity Creation's bounded metadata/goal reads plus one bounded mutate; no retries. */
export async function validateCampaignDeployment(required: { dependencies: PluginCapabilityDependencies; call: Parameters<PluginCapability<"campaign.validate.v1">>[0] }, optional?: CallOptions): Promise<Outcome<CampaignValidateOutput>> {
  const input = parseBoundary({ schema: campaignValidateInputSchema, input: required.call.input });
  if (!input.ok) return input;
  const context = readContext({ context: required.call.context });
  if (!context.ok) return context;
  const configured = await deploymentBinding({ required: { dependencies: required.dependencies, context: context.value,
    ...required.call.connection, plan: input.value.plan }, mode: "sandbox" }, optional);
  if (!configured.ok) return configured;
  const { binding, transport, plan, context: serviceContext } = configured.value;
  const operationId = input.value.operationId;
  const prepared = await prepareCreation({ dependencies: { binding, transport, clock: required.dependencies.clock,
    journal: { claim: unavailable, append: unavailable, get: unavailable, findCampaign: unavailable },
    authority: { dispatch: unavailable, billing: unavailable } }, context: serviceContext, call: { name: "create_paused", arguments: { operationId, plan } } });
  if (!prepared.ok) return prepared;
  const response = await transport.request({ method: "mutate", body: { mutateOperations: prepared.value.operations, partialFailure: false, validateOnly: true }, context: serviceContext, operationId });
  if (!response.ok) return response;
  const result = parseBoundary({ schema: z.record(z.string(), z.unknown()), input: response.value });
  if (!result.ok) return result;
  if (Object.hasOwn(result.value, "partialFailureError")) return failure({ code: "unavailable", message: "Google campaign validation failed" });
  return success({ value: { status: "validated" } });
}

/** Lift the existing host adapter; per-call binding and journal contain no global state. */
async function deployment(input: { required: CampaignDeploymentRequired; mode: "sandbox" | "read_only" }, optional?: CallOptions): Promise<Outcome<CampaignDeploymentReceipt>> {
  const { required, mode } = input;
  const configured = await deploymentBinding(input, optional);
  if (!configured.ok) return configured;
  const { binding, transport, context, plan } = configured.value;
  const journal = deploymentJournal({ required, binding });
  const adapter = createGooglePlugin({ binding, transport, clock: required.dependencies.clock, journal,
    authority: { dispatch: input => input.execute(), billing: unavailable },
  });
  const result = await adapter.invoke({ context, name: mode === "sandbox" ? "create_paused" : "reconcile",
    arguments: { operationId: required.operationId, ...(mode === "sandbox" ? { plan } : {}) } });
  if (!result.ok) return result;
  const receipt = result.value as Receipt;
  return parseBoundary({ schema: campaignDeploymentReceiptSchema, input: { ...receipt, state: "paused", entityIds: receipt.references ?? [] } });
}

/** Adapt only this invocation's checkpoints to the existing journal ABI.
 * Failed append leaves the previous durable record; provider references stay in the receipt.
 * @complexity O(1) journal entries; bounded record owned by the existing Search plan schema.
 */
function deploymentJournal({ required, binding }: { required: CampaignDeploymentRequired; binding: AccountBinding }): OperationJournalPort {
  const key = operationIdentity({ binding, operationId: required.operationId }).key;
  let record = asRecord({ value: required.saved.record }).key === key ? required.saved.record as OperationRecord : null;
  return {
    async claim(input) {
      if (required.saved.record !== null) return success({ value: { acquired: false, record: required.saved.record as OperationRecord } });
      const saved = await required.checkpoint({ step: "google", phase: "dispatch", record: input.record });
      if (!saved.ok) return saved;
      record = input.record;
      return success({ value: { acquired: true, record } });
    },
    async append(input) {
      const saved = await required.checkpoint({ step: "google", phase: "observation", record: input.record });
      if (saved.ok) record = input.record;
      return saved;
    },
    async get() { return success({ value: record }); },
    findCampaign: unavailable,
  };
}
/** No durable controlled-plan lookup/billing evidence is granted through deployment. */
async function unavailable(): Promise<Outcome<never>> {
  return failure({ code: "unavailable", message: unavailableReason });
}
