import type { MeasurementGrant, Outcome, ServiceContext } from "@open-marketing/contracts";
import { createMetaCapiBackend } from "../src/capi.js";
import type { MetaCapiConfiguration, MetaCapiEgressPort, MetaCapiRequest, MetaConversionAuthorityPort } from "../src/capi.js";
import { failure } from "../src/boundary.js";
import { clock, context, now, observer, pluginDigest } from "./fixtures.js";

export const configuration: MetaCapiConfiguration = { connectionId: "connection", accountId: "123", pixelId: "987", apiVersion: "v25.0", pluginDigest, destination: "meta-dataset-987", purpose: "ad-measurement", payloadSchema: "conversion.website.v1", mode: "production-server", timeoutMs: 15000, maxEventAgeMs: 604800000 };
export const serviceContext: ServiceContext = { scope: context.scope, serviceId: "measure-worker", correlationId: context.correlationId, traceId: context.traceId };
export const grant: MeasurementGrant = { kind: "measurement", grantId: "measurement-grant", scope: context.scope, connectionId: "connection", accountId: "123", eventTypes: ["signup", "trial"], destination: configuration.destination, purpose: configuration.purpose, payloadSchema: configuration.payloadSchema, payloadVersion: 1, expiresAt: now + 1000, revoked: false };
export const conversion: MetaCapiRequest = { context: serviceContext, event: { eventId: "stable-event", eventType: "signup", subjectId: "never-export-implicitly", occurredAt: now - 1000, destination: configuration.destination, purpose: configuration.purpose, identifiers: { email: " Alice@Example.com ", phone: "+1 (415) 555-2671", client_user_agent: "FixtureBrowser", event_source_url: "https://example.com/signup", fbp: "fb.1.1234567890.1234" } }, grant, deliveryId: "durable-delivery" };
export interface CapiFixture { backend: ReturnType<typeof createMetaCapiBackend>; calls: Parameters<MetaCapiEgressPort["send"]>[0][]; state: { consent: boolean; sends: number; outcome: "success" | "unknown" | "throw"; authorityFailure: boolean; current: boolean } }
/** Hand-written server fence/Graph response fixtures. No real token, request, scheduler or outbox. */
export function capiFixture(required: { configuration?: MetaCapiConfiguration } = {}): CapiFixture {
  const calls: CapiFixture["calls"] = [];
  const state: CapiFixture["state"] = { consent: true, sends: 0, outcome: "success", authorityFailure: false, current: true };
  const authority: MetaConversionAuthorityPort = { async dispatch(input) {
    if (state.authorityFailure) throw new Error("authority down");
    if (!state.consent) return failure({ code: "forbidden", message: "Consent withdrawn at dispatch" });
    return input.execute({ isCurrent: () => state.current });
  } };
  const egress: MetaCapiEgressPort = { async send(input): Promise<Outcome<unknown>> {
    if (!input.isCurrent()) return failure({ code: "forbidden", message: "Egress fence withdrawn after credential resolution" });
    calls.push(input); state.sends += 1;
    if (state.outcome === "throw") throw new Error("fixture timeout secret");
    if (state.outcome === "unknown") return { ok: true, value: { events_received: 0 } };
    return { ok: true, value: { events_received: 1, fbtrace_id: "fixture-trace" } };
  } };
  const backend = createMetaCapiBackend({ configuration: required.configuration ?? configuration, authority, egress, clock, observer });
  return { backend, calls, state };
}
