import type { MeasurementGrant, Outcome, ServiceContext } from "@open-marketing/contracts";
import { createMetaCapiBackend } from "../src/capi.js";
import type { MetaCapiConfiguration, MetaCapiEgressPort, MetaCapiRequest, MetaConversionAuthorityPort } from "../src/capi.js";
import { failure } from "../src/boundary.js";
import { clock, context, now, observer, pluginDigest } from "./fixtures.js";

export const configuration: MetaCapiConfiguration = { connectionId: "connection", accountId: "123", pixelId: "987", apiVersion: "v25.0", pluginDigest, destination: "meta-dataset-987", purpose: "ad-measurement", payloadSchema: "conversion.website.v1", mode: "production-server", timeoutMs: 15000, maxEventAgeMs: 604800000 };
export const serviceContext: ServiceContext = { scope: context.scope, serviceId: "measure-worker", correlationId: context.correlationId, traceId: context.traceId };
export const grant: MeasurementGrant = { kind: "measurement", grantId: "measurement-grant", scope: context.scope, connectionId: "connection", accountId: "123", eventTypes: ["signup", "trial"], destination: configuration.destination, purpose: configuration.purpose, payloadSchema: configuration.payloadSchema, payloadVersion: 1, expiresAt: now + 1000, revoked: false };
/** Fixed contacts handoff digests, not a plugin normalizer or runtime hasher. */
export const contactsHashes = { email: "ff8d9819fc0e12bf0d24892e45987e249a28dce836a85cad60e28eaaa8c6d976", phone: "758fbf68945f21c416814c539ab578876c8d98fb69e6da692def92cd52417fe0", external_id: "fc7df777c08a00350a62876ea699ec186f7f32c65b586222058e44be76e0df5a" };
export const conversion: MetaCapiRequest = { context: serviceContext, event: { eventId: "stable-event", eventType: "signup", subjectId: "never-export-implicitly", occurredAt: now - 1000, destination: configuration.destination, purpose: configuration.purpose, identifiers: { email: contactsHashes.email, phone: contactsHashes.phone, client_user_agent: "FixtureBrowser", event_source_url: "https://example.com/signup", fbp: "fb.1.1234567890.1234" } }, grant, deliveryId: "durable-delivery" };
export interface CapiFixture { backend: ReturnType<typeof createMetaCapiBackend>; calls: Parameters<MetaCapiEgressPort["send"]>[0][]; authorityCalls: Parameters<MetaConversionAuthorityPort["dispatch"]>[0][]; state: { consent: boolean; admitted: boolean; deniedIdentifierKeys: string[]; sends: number; outcome: "success" | "unknown" | "throw" | "timeout"; authorityFailure: boolean; current: boolean; withdrawAtEgress: boolean } }
/** Hand-written server fence/Graph response fixtures. No real token, request, scheduler or outbox. */
export function capiFixture(required: { configuration?: MetaCapiConfiguration } = {}): CapiFixture {
  const calls: CapiFixture["calls"] = [];
  const authorityCalls: CapiFixture["authorityCalls"] = [];
  const state: CapiFixture["state"] = { consent: true, admitted: true, deniedIdentifierKeys: [], sends: 0, outcome: "success", authorityFailure: false, current: true, withdrawAtEgress: false };
  const authority: MetaConversionAuthorityPort = { async dispatch(input) {
    authorityCalls.push(input);
    if (state.authorityFailure) throw new Error("authority down");
    if (!state.admitted) return failure({ code: "unavailable", message: "Graph version/dataset capability unverified" });
    if (!state.consent) return failure({ code: "forbidden", message: "Consent withdrawn at dispatch" });
    const keys = [...Object.keys(input.event.identifiers), ...Object.keys(input.payload.data[0].user_data)];
    if (keys.some(key => state.deniedIdentifierKeys.includes(key))) return failure({ code: "forbidden", message: "Identifier/attribution consent missing" });
    return input.execute({ isCurrent: () => state.current });
  } };
  const egress: MetaCapiEgressPort = { async send(input): Promise<Outcome<unknown>> {
    if (state.withdrawAtEgress) state.current = false;
    if (!input.isCurrent()) return failure({ code: "forbidden", message: "Egress fence withdrawn after credential resolution" });
    calls.push(input); state.sends += 1;
    if (state.outcome === "throw") throw new Error("fixture timeout secret");
    if (state.outcome === "timeout") return failure({ code: "unavailable", message: "Acknowledgement lost after POST" });
    if (state.outcome === "unknown") return { ok: true, value: { events_received: 0 } };
    return { ok: true, value: { events_received: 1, fbtrace_id: "fixture-trace" } };
  } };
  const backend = createMetaCapiBackend({ configuration: required.configuration ?? configuration, authority, egress, clock, observer });
  return { backend, calls, authorityCalls, state };
}
