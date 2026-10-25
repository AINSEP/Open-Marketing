import { z } from "zod";
import { callContextSchema, idSchema, scopeSchema } from "@open-marketing/contracts";
import type { AppError, CallOptions, Outcome } from "@open-marketing/contracts";
import { commandSchema, vendorIdSchema } from "./commands.js";
import type { VkAdsAdapter, VkDependencies, VkInvocation, VkResult } from "./ports.js";

const invocationSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, command: commandSchema });
const configurationSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, accountId: vendorIdSchema.nullable() });

/** Inert boundary for the held VK read integration. No vendor origin is guessed.
 * @param required - Live server admission, binding and existing credential/fetch/clock/observer seams.
 * @returns Typed denials; admitted reads remain unavailable until operation evidence is complete.
 * @example createVkAdsAdapter({ admitted: false, configuration, credentials, fetch, clock, observer })
 * @complexity O(b) time/space for <=64KiB accepted input; zero credential/network/time reads.
 */
export function createVkAdsAdapter(required: VkDependencies): VkAdsAdapter {
  return { async invoke(input, options) { return invoke({ dependencies: required, input }, options); } };
}

/** Validate before reporting the evidence hold; authority cannot override missing vendor facts.
 * @returns forbidden/cancelled/invalid_input/limit_exceeded, or unavailable without any I/O.
 * @complexity O(b) validation with a 64KiB input cap; no token material enters diagnostics.
 */
function invoke(required: { dependencies: VkDependencies; input: VkInvocation }, optional?: CallOptions): Outcome<VkResult> {
  if (required.dependencies.admitted !== true) return failure({ code: "forbidden" });
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  try {
    const json = JSON.stringify(required.input);
    if (json === undefined || Buffer.byteLength(json) > 65536) return failure({ code: "limit_exceeded" });
    const invocation = invocationSchema.safeParse(JSON.parse(json));
    const configuration = configurationSchema.safeParse(required.dependencies.configuration);
    if (!invocation.success || !configuration.success) return failure({ code: "invalid_input" });
    const { scope } = invocation.data.context;
    if (scope.ownerId !== configuration.data.scope.ownerId || scope.workspaceId !== configuration.data.scope.workspaceId) return failure({ code: "forbidden" });
    return unavailable({ command: invocation.data.command.kind });
  } catch { return failure({ code: "invalid_input" }); }
}

/** Static operation-specific evidence status, not a configurable policy override. */
function unavailable(required: { command: VkInvocation["command"]["kind"] }): Outcome<never> {
  const message = required.command === "report"
    ? "VK reporting unavailable: spend units/currency, timezone and campaign mapping are unverified"
    : "VK reads unavailable: API origin for the documented relative paths is unverified";
  return { ok: false, error: { code: "unavailable", message, retryable: false } };
}
/** Redacted boundary errors never include arguments, credentials or provider text. */
function failure(required: { code: AppError["code"] }): Outcome<never> {
  return { ok: false, error: { code: required.code, message: "VK request " + required.code, retryable: false } };
}
