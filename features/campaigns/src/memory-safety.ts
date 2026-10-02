import { z } from "zod";
import { callContextSchema, idSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome, Scope } from "@open-marketing/contracts";
import type { CampaignSafetyPort } from "./ports.js";
import type { ApprovedLaunchRequest, CampaignDraft, LaunchProposal } from "./types.js";
import { checkCancelled } from "./repo-rules.js";
import { createInputSchema, digest, exactMatch, fail, parseBoundary, proposalSchema, requestSchema, scopedKey, scopeKey, success } from "./rules.js";

/** Fixture-only binding. Production account writes are possible only in always-on mode. */
export interface MemoryCampaignAccount { readonly scope: Scope; readonly connectionId: string; readonly accountId: string; readonly accountMode: "sandbox" | "production"; readonly allowCreation: boolean }
/** Explicit test approval/halt controls; production adapts @open-marketing/safety. */
export interface MemoryCampaignSafety extends CampaignSafetyPort {
  approve(required: { context: CallContext; proposal: LaunchProposal; approvalId: string }): Outcome<void>;
  revoke(required: { context: CallContext; approvalId: string }): void;
  halt(required: { scope: Scope; halted: boolean }): void;
}
interface Grant { context: CallContext; proposal: LaunchProposal; consumed: boolean }
const authorizationSchema = z.strictObject({ context: callContextSchema, request: requestSchema, proposal: proposalSchema });
const approvalSchema = z.strictObject({ context: callContextSchema, proposal: proposalSchema, approvalId: idSchema });

/** Fail-closed safety double; empty config grants nothing. Exact approvals are consumed
 * synchronously before execute, so a halt cannot interleave between check and egress.
 * It models grants/barriers, not production plugin/limit proofs.
 * @example createMemoryCampaignSafety({ mode: "local-sandbox", accounts: [sandboxBinding] });
 * @complexity O(a) account bindings (bounded at 100), O(n) bounded proposal bytes.
 */
export function createMemoryCampaignSafety(required: { mode?: "always-on" | "local-sandbox" | "read-only"; accounts?: readonly MemoryCampaignAccount[]; maxApprovals?: number }): MemoryCampaignSafety {
  const accounts = structuredClone(required.accounts ?? []).slice(0, 100);
  const mode = required.mode ?? "local-sandbox";
  const halted = new Set<string>();
  const grants = new Map<string, Grant>();
  const maxApprovals = required.maxApprovals ?? 10000;
  function creationDecision(input: { context: CallContext; draft: CampaignDraft }, options?: CallOptions): Outcome<{ permitId: string }> {
    const parsed = parseBoundary({ schema: createInputSchema, input });
    if (!parsed.ok) return parsed;
    const cancelled = checkCancelled({ options });
    if (!cancelled.ok) return cancelled;
    const { context, draft } = parsed.value;
    return accountDecision({ context, connectionId: draft.connectionId, accountId: draft.accountId, accounts, mode, halted });
  }
  function launchDecision(input: { context: CallContext; request: ApprovedLaunchRequest; proposal: LaunchProposal }, options?: CallOptions): Outcome<{ permitId: string }> {
    const parsed = parseBoundary({ schema: authorizationSchema, input });
    if (!parsed.ok) return parsed;
    const cancelled = checkCancelled({ options });
    if (!cancelled.ok) return cancelled;
    const { context, request, proposal } = parsed.value;
    if (!exactMatch({ request, proposal })) return fail({ code: "conflict", message: "Exact card mismatch" });
    const account = accountDecision({ context, connectionId: proposal.arguments.connectionId, accountId: proposal.arguments.accountId, accounts, mode, halted });
    if (!account.ok) return account;
    const grant = grants.get(scopedKey({ scope: context.scope, id: request.approvalId }));
    if (!grant || grant.consumed) return fail({ code: "forbidden", message: "Fresh exact approval required" });
    if (digest({ value: grant.proposal }) !== digest({ value: proposal }) || digest({ value: grant.context.principal }) !== digest({ value: context.principal })) return fail({ code: "forbidden", message: "Approval binding changed" });
    return success({ value: { permitId: request.approvalId } });
  }
  return {
    approve(input) {
      const parsed = parseBoundary({ schema: approvalSchema, input });
      if (!parsed.ok) return parsed;
      const { context, proposal, approvalId } = parsed.value;
      const key = scopedKey({ scope: context.scope, id: approvalId });
      if (grants.has(key)) return fail({ code: "conflict", message: "Approval identity already exists" });
      if (grants.size >= maxApprovals) return fail({ code: "limit_exceeded", message: "Approval capacity reached" });
      grants.set(key, structuredClone({ context, proposal, consumed: false }));
      return success({ value: undefined });
    },
    revoke(input) { grants.delete(scopedKey({ scope: input.context.scope, id: input.approvalId })); },
    halt(input) {
      const key = scopeKey({ scope: input.scope });
      if (input.halted) halted.add(key);
      else halted.delete(key);
    },
    async authorizeCreation(input, options) { return creationDecision(input, options); },
    async authorize(input, options) { return launchDecision(input, options); },
    async dispatchCreation(input, options) {
      const decision = creationDecision({ context: input.context, draft: input.draft }, options);
      if (!decision.ok) return decision;
      return input.execute(decision.value);
    },
    async dispatchLaunch(input, options) {
      const decision = launchDecision({ context: input.context, request: input.request, proposal: input.proposal }, options);
      if (!decision.ok) return decision;
      const grant = grants.get(scopedKey({ scope: input.context.scope, id: input.request.approvalId }));
      if (!grant) return fail({ code: "forbidden", message: "Exact approval disappeared" });
      grant.consumed = true;
      return input.execute(decision.value);
    },
  };
}
function accountDecision(required: { context: CallContext; connectionId: string; accountId: string; accounts: readonly MemoryCampaignAccount[]; mode: string; halted: ReadonlySet<string> }): Outcome<{ permitId: string }> {
  const { context, connectionId, accountId, accounts, mode, halted } = required;
  if (context.principal.kind === "owner" && context.principal.ownerId !== context.scope.ownerId) return fail({ code: "forbidden", message: "Owner scope mismatch" });
  if (halted.has(scopeKey({ scope: context.scope }))) return fail({ code: "forbidden", message: "Account operations halted" });
  if (mode === "read-only") return fail({ code: "forbidden", message: "Read-only account mode" });
  const binding = accounts.find(account => scopeKey({ scope: account.scope }) === scopeKey({ scope: context.scope }) && account.connectionId === connectionId && account.accountId === accountId);
  if (!binding || !binding.allowCreation) return fail({ code: "forbidden", message: "Account/workspace binding or write grant missing" });
  if (binding.accountMode === "production" && mode !== "always-on") return fail({ code: "forbidden", message: "Production writes require always-on server" });
  return success({ value: { permitId: "memory-write-" + digest({ value: [context.scope, connectionId, accountId] }) } });
}
