import { parseBoundary } from "@open-marketing/contracts";
import type { CallOptions, ClockPort, Outcome } from "@open-marketing/contracts";
import type { ConversionSourceAuthenticationPort, MeasureRepoPort, MeasurementShareabilityPort } from "../ports.js";
import type { ConversionInput, ConversionReceipt, VerifiedConversionSource } from "../types.js";
import { assessmentSchema, authenticationSchema, conversionSchema, failure, ingestionContext, receiptSchema, sameScope, sourceSchema } from "../rules.js";

type Input = { source: VerifiedConversionSource; event: ConversionInput };
/** Validate/authenticate before consent or storage; repo owns the atomic outbox commit.
 * @complexity O(k) for bounded payload; three bounded port calls, no vendor I/O. */
export async function ingest(required: { input: Input; repo: MeasureRepoPort; policy: MeasurementShareabilityPort; authentication?: ConversionSourceAuthenticationPort; clock: ClockPort }, optional?: CallOptions): Promise<Outcome<ConversionReceipt>> {
  const parsed = validateInput({ input: required.input, now: required.clock.now({}) });
  if (!parsed.ok) return parsed;
  const input = parsed.value;
  const authenticated = await authenticate({ authentication: required.authentication, source: input.source }, optional);
  if (!authenticated.ok) return authenticated;
  const context = ingestionContext(input);
  const assessment = await required.policy.assess({ context, event: input.event }, optional);
  if (!assessment.ok) return assessment;
  const consent = parseBoundary({ schema: assessmentSchema, input: assessment.value });
  if (!consent.ok) return consent;
  if (!consent.value.allowed) return failure({ code: "forbidden", message: "Purpose-bound measurement consent denied" });
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Measurement ingestion cancelled" });
  const receipt = await required.repo.appendConversion(input, optional);
  if (!receipt.ok) return receipt;
  return parseBoundary({ schema: receiptSchema, input: receipt.value });
}
/** Pure preflight rejects forged cross-scope context and future event timestamps. */
function validateInput(required: { input: Input; now: number }): Outcome<Input> {
  const source = parseBoundary({ schema: sourceSchema, input: required.input.source });
  if (!source.ok) return source;
  const event = parseBoundary({ schema: conversionSchema, input: required.input.event });
  if (!event.ok) return event;
  if (event.value.occurredAt > required.now) return failure({ code: "invalid_input", message: "Conversion occurs in the future" });
  const context = source.value.context;
  if (context && !sameScope({ left: context.scope, right: source.value.scope })) return failure({ code: "forbidden", message: "Source context scope mismatch" });
  return { ok: true, value: { source: source.value, event: event.value } };
}
async function authenticate(required: { authentication?: ConversionSourceAuthenticationPort; source: VerifiedConversionSource }, optional?: CallOptions): Promise<Outcome<void>> {
  if (!required.authentication) return failure({ code: "unauthenticated", message: "Source authenticator is required" });
  const result = await required.authentication.verify({ source: required.source }, optional);
  if (!result.ok) return result;
  const parsed = parseBoundary({ schema: authenticationSchema, input: result.value });
  if (!parsed.ok) return parsed;
  if (!parsed.value.authenticated) return failure({ code: "unauthenticated", message: "Source authentication denied" });
  return { ok: true, value: undefined };
}
