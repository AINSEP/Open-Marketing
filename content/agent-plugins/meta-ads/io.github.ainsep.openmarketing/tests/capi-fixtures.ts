import { pluginConfigurationSchema } from "@open-marketing/contracts";
import type { MeasurementGrant, ServiceContext } from "@open-marketing/contracts";
import { createConversionDelivery } from "../src/index.js";
import type { MetaCapiPayload, MetaCapiRequest, MetaConversionAuthorityPort } from "../src/capi.js";
import { failure } from "../src/boundary.js";
import { clock, context, now, observer, pluginDigest } from "./fixtures.js";

export const configuration = pluginConfigurationSchema.parse({ scope: context.scope, connectionId: "connection", accountId: "123", pluginDigest, settings: { conversionConfiguration: { datasetId: "987" } } });
export const serviceContext: ServiceContext = { scope: context.scope, serviceId: "measure-worker", correlationId: context.correlationId, traceId: context.traceId };
export const grant: MeasurementGrant = { kind: "measurement", grantId: "measurement-grant", scope: context.scope, connectionId: "connection", accountId: "123", definitionIds: ["signup"], destination: "meta-ads", purpose: "ad-measurement", payloadSchema: "conversion.website.v1", payloadVersion: 1, expiresAt: now + 1000, revoked: false };
/** Fixed contacts handoff digests, not a plugin normalizer or runtime hasher. */
export const contactsHashes = { email: "ff8d9819fc0e12bf0d24892e45987e249a28dce836a85cad60e28eaaa8c6d976", phone: "758fbf68945f21c416814c539ab578876c8d98fb69e6da692def92cd52417fe0", phone_digits: "e323ec626319ca94ee8bff2e4c87cf613be6ea19919ed1364124e16807ab3176", external_id: "fc7df777c08a00350a62876ea699ec186f7f32c65b586222058e44be76e0df5a" };
export const conversion: MetaCapiRequest = { context: serviceContext, event: { eventId: "stable-event", definitionId: "signup", subjectId: "never-export-implicitly", occurredAt: now - 1000, destination: grant.destination, purpose: grant.purpose, identifierDigests: { email: contactsHashes.email }, identifiers: { email: contactsHashes.email, phone: contactsHashes.phone, phone_digits: contactsHashes.phone_digits, gclid: "ignored-google-click", client_user_agent: "FixtureBrowser", event_source_url: "https://example.com/signup", fbp: "fb.1.1234567890.1234" } }, grant, deliveryId: "durable-delivery" };
export interface CapiFixture {
  backend: ReturnType<typeof createConversionDelivery>;
  calls: { endpoint: string; init?: RequestInit; payload: MetaCapiPayload }[];
  authorityCalls: Parameters<MetaConversionAuthorityPort["dispatch"]>[0][];
  state: { consent: boolean; deniedIdentifierKeys: string[]; sends: number; credentialCalls: number; credentialFailure: boolean; outcome: "success" | "unknown" | "throw" | "timeout"; authorityFailure: boolean; current: boolean; withdrawAtEgress: boolean; abortAtCredential?: AbortController };
}
/** Real factory/Graph transport with one-call credential and fetch fixtures; never live I/O. */
export function capiFixture(required: { configuration?: typeof configuration } = {}): CapiFixture {
  const calls: CapiFixture["calls"] = [];
  const authorityCalls: CapiFixture["authorityCalls"] = [];
  const state: CapiFixture["state"] = { consent: true, deniedIdentifierKeys: [], sends: 0, credentialCalls: 0, credentialFailure: false, outcome: "success", authorityFailure: false, current: true, withdrawAtEgress: false };
  const authority: MetaConversionAuthorityPort = { async dispatch(input) {
    authorityCalls.push(input);
    if (state.authorityFailure) throw new Error("authority down");
    if (!state.consent) return failure({ code: "forbidden", message: "Consent withdrawn at dispatch" });
    const keys = [...Object.keys(input.event.identifiers), ...Object.keys(input.payload.data[0].user_data)];
    if (keys.some(key => state.deniedIdentifierKeys.includes(key))) return failure({ code: "forbidden", message: "Identifier/attribution consent missing" });
    return input.execute({ isCurrent: () => state.current });
  } };
  const backend = createConversionDelivery({ configuration: required.configuration ?? configuration, authority, clock, observer,
    credentials: { async access() {
      state.credentialCalls += 1;
      if (state.withdrawAtEgress) state.current = false;
      state.abortAtCredential?.abort();
      if (state.credentialFailure) return failure({ code: "forbidden", message: "fixture-token-secret credential JSON" });
      return { ok: true, value: { accessToken: "fixture-token-secret" } };
    } },
    fetch: async (url, init) => {
      const data = JSON.parse(new URLSearchParams(String(init?.body)).get("data") ?? "null") as MetaCapiPayload["data"];
      calls.push({ endpoint: String(url), init, payload: { data } }); state.sends += 1;
      if (state.outcome === "throw" || state.outcome === "timeout") throw new Error("fixture-token-secret acknowledgement lost");
      return Response.json({ events_received: state.outcome === "unknown" ? 0 : 1, fbtrace_id: "fixture-trace" });
    },
    wait: async () => ({ ok: true, value: undefined }),
  });
  return { backend, calls, authorityCalls, state };
}
