import type { CallContext, EffectEnvelope, Outcome } from "@open-marketing/contracts";
import { failure, parse, protect, success } from "./schema.ts";
import { bindingSchema, contextSchema, toolSchemas } from "./schemas.ts";
import { digest, effectFor, operationIdentity, validateHierarchy, validatePlan } from "./rules.ts";
import { budgetOperations, createOperations, statusOperations } from "./mapping.ts";
import { asRecord, planDigest, readAccount, readHierarchy, search } from "./readback.ts";
import type { AccountBinding, GooglePluginDependencies, Hierarchy, OperationRecord, Receipt, ToolArguments, ToolCall, ToolName } from "./types.ts";

export interface GooglePlugin {
  invoke(required: { context: CallContext; name: string; arguments: unknown }): Promise<Outcome<unknown>>;
  preview(required: { context: CallContext; name: string; arguments: unknown }): Promise<Outcome<EffectEnvelope>>;
}
/** Inert factory: host injects account authority, Google transport, clock and ONE outbox
 * journal. Methods accept only closed narrow tool arguments. No automatic retries.
 * @example createGooglePlugin({ binding, transport, journal, authority, clock }) */
export function createGooglePlugin(required: GooglePluginDependencies): GooglePlugin {
  return {
    invoke: input => protect({ work: () => invoke({ dependencies: required, ...input }) }),
    preview: input => protect({ work: () => preview({ dependencies: required, ...input }) }),
  };
}
function checkedCall(required: { dependencies: GooglePluginDependencies; context: CallContext; name: string; arguments: unknown }): Outcome<ToolCall> {
  const binding = parse<AccountBinding>({ schema: bindingSchema, input: required.dependencies.binding });
  if (!binding.ok) return binding;
  const context = parse<CallContext>({ schema: contextSchema, input: required.context });
  if (!context.ok) return context;
  if (context.value.scope.ownerId !== binding.value.scope.ownerId || context.value.scope.workspaceId !== binding.value.scope.workspaceId) return failure({ code: "forbidden", message: "Cross-workspace plugin call" });
  if (!Object.hasOwn(toolSchemas, required.name)) return failure({ code: "unavailable", message: "Tool is unavailable" });
  const name = required.name as ToolName;
  const args = parse<ToolArguments>({ schema: toolSchemas[name], input: required.arguments });
  if (!args.ok) return args;
  return success({ value: { name, arguments: args.value } });
}
async function invoke(required: { dependencies: GooglePluginDependencies; context: CallContext; name: string; arguments: unknown }): Promise<Outcome<unknown>> {
  const checked = checkedCall(required);
  if (!checked.ok) return checked;
  const call = checked.value;
  switch (call.name) {
    case "list_accounts": return readAccount({ ...required, operationId: call.arguments.operationId });
    case "read_campaign":
    case "read_budget": return readCampaign({ ...required, call });
    case "report": return report({ ...required, call });
    case "reconcile": return reconcile({ ...required, call });
    case "create_paused":
    case "activate":
    case "set_budget":
    case "pause": return write({ ...required, call });
    default: { const exhaustive: never = call.name; return exhaustive; }
  }
}
async function readCampaign(required: { dependencies: GooglePluginDependencies; context: CallContext; call: ToolCall }): Promise<Outcome<Hierarchy>> {
  if (!("campaignId" in required.call.arguments)) return failure({ code: "invalid_input", message: "Campaign ID is required" });
  return readHierarchy({ ...required, campaignId: required.call.arguments.campaignId, operationId: required.call.arguments.operationId });
}
async function preview(required: { dependencies: GooglePluginDependencies; context: CallContext; name: string; arguments: unknown }): Promise<Outcome<EffectEnvelope>> {
  const checked = checkedCall(required);
  if (!checked.ok) return checked;
  const call = checked.value;
  if (!isWrite({ name: call.name })) return failure({ code: "invalid_input", message: "Only mutations have an effect preview" });
  const prepared = await prepare({ ...required, call });
  if (!prepared.ok) return prepared;
  return success({ value: prepared.value.effect });
}
function isWrite(required: { name: ToolName }): boolean {
  return ["create_paused", "activate", "set_budget", "pause"].includes(required.name);
}
interface Prepared { operations: Record<string, unknown>[]; effect: EffectEnvelope; hierarchy?: Hierarchy }
async function prepare(required: { dependencies: GooglePluginDependencies; context: CallContext; call: ToolCall }): Promise<Outcome<Prepared>> {
  const { dependencies, call } = required;
  if (dependencies.binding.mode === "read_only") return failure({ code: "forbidden", message: "Account binding is read-only" });
  if (call.name === "create_paused") return prepareCreation(required);
  const hierarchy = await readCampaign(required);
  if (!hierarchy.ok) return hierarchy;
  if (call.name === "pause") {
    const effect = effectFor({ binding: dependencies.binding, call, now: dependencies.clock.now({}) });
    if (!effect.ok) return effect;
    return success({ value: { hierarchy: hierarchy.value, effect: effect.value, operations: statusOperations({ hierarchy: hierarchy.value, status: "PAUSED" }) } });
  }
  return prepareSpend({ ...required, hierarchy: hierarchy.value });
}
async function prepareCreation(required: { dependencies: GooglePluginDependencies; context: CallContext; call: ToolCall }): Promise<Outcome<Prepared>> {
  if (!("plan" in required.call.arguments)) return failure({ code: "invalid_input", message: "Search plan is required" });
  const { dependencies, call } = required;
  const plan = validatePlan({ plan: required.call.arguments.plan, binding: dependencies.binding });
  if (!plan.ok) return plan;
  const account = await readAccount({ ...required, operationId: call.arguments.operationId });
  if (!account.ok) return account;
  if (dependencies.binding.mode === "sandbox" && !account.value.testAccount) return failure({ code: "forbidden", message: "Sandbox creation requires a verified Google test account" });
  const effect = effectFor({ binding: dependencies.binding, call, now: dependencies.clock.now({}) });
  if (!effect.ok) return effect;
  const identity = operationIdentity({ binding: dependencies.binding, operationId: call.arguments.operationId });
  return success({ value: { effect: effect.value, operations: createOperations({ customerId: dependencies.binding.customerId, plan: plan.value, marker: identity.marker, timezone: dependencies.binding.timezone }) } });
}
async function prepareSpend(required: { dependencies: GooglePluginDependencies; context: CallContext; call: ToolCall; hierarchy: Hierarchy }): Promise<Outcome<Prepared>> {
  const { dependencies, call, hierarchy } = required;
  if (call.name === "activate") {
    const paused = validateHierarchy({ binding: dependencies.binding, hierarchy, desired: "PAUSED" });
    if (!paused.ok) return paused;
  }
  const known = await dependencies.journal.findCampaign({ binding: dependencies.binding, campaignId: hierarchy.campaignId });
  if (!known.ok) return known;
  if (!known.value || !("plan" in known.value.arguments)) return failure({ code: "forbidden", message: "No durable controlled-plan mapping exists" });
  const expected = planDigest({ plan: { ...known.value.arguments.plan, name: known.value.marker, averageDailyBudgetMicros: hierarchy.averageDailyBudgetMicros } });
  if (hierarchy.planDigest !== expected) return failure({ code: "conflict", message: "Remote plan changed; exact review is required" });
  const evidence = await dependencies.authority.billing({ context: required.context, binding: dependencies.binding, hierarchy });
  if (!evidence.ok) return evidence;
  const effect = effectFor({ binding: dependencies.binding, call, hierarchy, evidence: evidence.value, now: dependencies.clock.now({}) });
  if (!effect.ok) return effect;
  const operations = call.name === "set_budget" && "averageDailyBudgetMicros" in call.arguments
    ? budgetOperations({ hierarchy, averageDailyBudgetMicros: call.arguments.averageDailyBudgetMicros })
    : statusOperations({ hierarchy, status: "ENABLED" });
  return success({ value: { operations, effect: effect.value, hierarchy } });
}
/** Claim before send; concurrent duplicates return original status. Failed/unknown writes
 * retain their identity and MUST reconcile. Journal failures never authorize retry.
 * @complexity Fixed reads plus one atomic mutation and bounded readback. */
async function write(required: { dependencies: GooglePluginDependencies; context: CallContext; call: ToolCall }): Promise<Outcome<Receipt>> {
  const { dependencies, call } = required;
  const identity = operationIdentity({ binding: dependencies.binding, operationId: call.arguments.operationId });
  const record: OperationRecord = { ...identity, accountKey: operationIdentity({ binding: dependencies.binding, operationId: "binding" }).key, operationId: call.arguments.operationId, name: call.name, digest: digest({ value: call }), arguments: call.arguments, receipt: { operationId: call.arguments.operationId, status: "unknown" } };
  const claimed = await dependencies.journal.claim({ record });
  if (!claimed.ok) return claimed;
  if (claimed.value.record.digest !== record.digest) return failure({ code: "conflict", message: "Operation identity reused with different arguments" });
  if (!claimed.value.acquired) return success({ value: claimed.value.record.receipt });
  const prepared = await prepare(required);
  if (!prepared.ok) return prepared;
  const result = await dependencies.authority.dispatch({ context: required.context, binding: dependencies.binding, effect: prepared.value.effect,
    execute: () => sendMutation({ ...required, record, prepared: prepared.value }),
  });
  if (!result.ok) return result;
  const appended = await dependencies.journal.append({ record: { ...record, receipt: result.value } });
  if (!appended.ok) return success({ value: record.receipt });
  return result;
}
async function sendMutation(required: { dependencies: GooglePluginDependencies; context: CallContext; call: ToolCall; record: OperationRecord; prepared: Prepared }): Promise<Outcome<Receipt>> {
  const { dependencies, call, record, prepared } = required;
  const response = await dependencies.transport.request({ method: "mutate", body: { mutateOperations: prepared.operations, partialFailure: false, validateOnly: false }, context: required.context, operationId: record.operationId });
  if (!response.ok) return success({ value: record.receipt });
  const value = asRecord({ value: response.value });
  if (value.partialFailureError || !Array.isArray(value.mutateOperationResponses) || value.mutateOperationResponses.length !== prepared.operations.length) return success({ value: record.receipt });
  const hierarchy = await readHierarchy({ ...required, operationId: record.operationId, campaignId: prepared.hierarchy?.campaignId, marker: record.marker });
  if (!hierarchy.ok) return success({ value: record.receipt });
  if (!mutationObserved({ call, record, hierarchy: hierarchy.value })) return success({ value: record.receipt });
  return success({ value: { operationId: record.operationId, status: "acknowledged", campaignId: hierarchy.value.campaignId, hierarchy: hierarchy.value } });
}
function mutationObserved(required: { call: ToolCall; record: OperationRecord; hierarchy: Hierarchy }): boolean {
  const { call, record, hierarchy } = required;
  if (call.name === "set_budget" && "averageDailyBudgetMicros" in call.arguments) return hierarchy.averageDailyBudgetMicros === call.arguments.averageDailyBudgetMicros;
  const desired = call.name === "activate" ? "ENABLED" : "PAUSED";
  if (hierarchy.status !== desired || hierarchy.childStatuses.some(status => status !== desired)) return false;
  if (!("plan" in record.arguments)) return true;
  return hierarchy.planDigest === planDigest({ plan: { ...record.arguments.plan, name: record.marker } });
}
/** Reconciliation is read-only, bounded, and never blindly resends missing/partial writes. */
async function reconcile(required: { dependencies: GooglePluginDependencies; context: CallContext; call: ToolCall }): Promise<Outcome<Receipt>> {
  const { dependencies, call } = required;
  const identity = operationIdentity({ binding: dependencies.binding, operationId: call.arguments.operationId });
  const existing = await dependencies.journal.get({ key: identity.key });
  if (!existing.ok) return existing;
  if (!existing.value) return failure({ code: "unavailable", message: "No durable operation mapping exists" });
  const record = existing.value;
  if (record.receipt.status === "acknowledged") return success({ value: record.receipt });
  const campaignId = "campaignId" in record.arguments ? record.arguments.campaignId : undefined;
  const hierarchy = await readHierarchy({ ...required, operationId: record.operationId, campaignId, marker: record.marker });
  if (!hierarchy.ok) return success({ value: record.receipt });
  const original: ToolCall = { name: record.name, arguments: record.arguments };
  if (!mutationObserved({ call: original, record, hierarchy: hierarchy.value })) return success({ value: record.receipt });
  const receipt: Receipt = { operationId: record.operationId, status: "acknowledged", campaignId: hierarchy.value.campaignId, hierarchy: hierarchy.value };
  const appended = await dependencies.journal.append({ record: { ...record, receipt } });
  if (!appended.ok) return appended;
  return success({ value: receipt });
}
/** Fixed account/date reporting; platform-attributed conversions are deliberately absent. */
async function report(required: { dependencies: GooglePluginDependencies; context: CallContext; call: ToolCall }): Promise<Outcome<unknown>> {
  const args = required.call.arguments;
  if (!("startDate" in args)) return failure({ code: "invalid_input", message: "Reporting dates are required" });
  const start = Date.parse(args.startDate + "T00:00:00Z");
  const end = Date.parse(args.endDate + "T00:00:00Z");
  if (!validReportDates({ start, end, args })) return failure({ code: "invalid_input", message: "Reporting window must be valid and at most 31 days" });
  const account = await readAccount({ ...required, operationId: args.operationId });
  if (!account.ok) return account;
  const rows = await search({ ...required, operationId: args.operationId, query: `SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions FROM customer WHERE segments.date >= '${args.startDate}' AND segments.date < '${args.endDate}'` });
  if (!rows.ok) return rows;
  const items = rows.value.map(row => ({ date: asRecord({ value: row.segments }).date, costMicros: asRecord({ value: row.metrics }).costMicros ?? "0", clicks: asRecord({ value: row.metrics }).clicks ?? "0", impressions: asRecord({ value: row.metrics }).impressions ?? "0" }));
  if (items.some(item => !reportItemValid({ item, startDate: args.startDate, endDate: args.endDate }))) return failure({ code: "invalid_input", message: "Malformed Google reporting row" });
  return success({ value: { accountId: account.value.customerId, currency: account.value.currency, timezone: account.value.timezone, retrievedAt: required.dependencies.clock.now({}), costSemantics: "served_cost_not_billed_cost", items } });
}
function validReportDates(required: { start: number; end: number; args: { startDate: string; endDate: string } }): boolean {
  const { start, end, args } = required;
  return Number.isFinite(start) && Number.isFinite(end) && start < end && end - start <= 31 * 86400000 && new Date(start).toISOString().slice(0, 10) === args.startDate && new Date(end).toISOString().slice(0, 10) === args.endDate;
}
function reportItemValid(required: { item: { date: unknown; costMicros: unknown; clicks: unknown; impressions: unknown }; startDate: string; endDate: string }): boolean {
  const { item } = required;
  const dateValid = typeof item.date === "string" && item.date >= required.startDate && item.date < required.endDate;
  return dateValid && [item.costMicros, item.clicks, item.impressions].every(value => typeof value === "string" && /^[0-9]{1,18}$/.test(value));
}
