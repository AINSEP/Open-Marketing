import { createSqliteFixture } from "@open-marketing/om-db/testing";
import { readFileSync } from "node:fs";
import type { CallContext, ClockPort, IdPort, Outcome } from "@open-marketing/contracts";
import { encodeCampaignKey } from "@open-marketing/contracts";
import type { CampaignKey } from "@open-marketing/contracts";
import type { AttributionTouch, CollectionAuthorityPort, ObservedCampaignPort, Visit, VisitTokenPort, WebEvent } from "../index.js";

export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const otherWorkspace: CallContext = { ...context, scope: { ...context.scope, workspaceId: "other-workspace" } };
export const otherOwner: CallContext = { ...context, scope: { ...context.scope, ownerId: "other-owner" }, principal: { kind: "owner", ownerId: "other-owner" } };
export const visit: Visit = { visitId: "visit", scope: context.scope, anonymousId: "anonymous", subjectId: null, expiresAt: 2000 };
export const campaign: CampaignKey = { pluginId: "google-ads", accountId: "account", vendorCampaignId: "campaign" };
export function encodedCampaign(required: { key?: CampaignKey } = {}): string {
  const result = encodeCampaignKey({ key: required.key ?? campaign });
  if (!result.ok) throw new Error("Invalid campaign fixture");
  return result.value;
}
export const destinationUrl = "https://site.example.test/landing";
export function observedFixture(required: { keys?: readonly CampaignKey[] } = {}): ObservedCampaignPort {
  const known = new Set((required.keys ?? [campaign]).map(key => encodedCampaign({ key })));
  return { async observed(input) {
    if (input.context.scope.ownerId !== context.scope.ownerId || input.context.scope.workspaceId !== context.scope.workspaceId) return { ok: true, value: [] };
    return { ok: true, value: input.keys.filter(key => known.has(encodedCampaign({ key }))) };
  } };
}

export function event(required: Partial<WebEvent> = {}): WebEvent {
  return { eventId: "event", schema: "om.web.landing", version: 1, source: "first-party", anonymousId: "anonymous", name: "landing", properties: { linkId: "link", campaignId: encodedCampaign(), gclid: "google-click", fbclid: "meta-click" }, occurredAt: 100, receivedAt: 0, cursor: 0, traceId: "trace", ...required };
}
export function touch(required: { event?: WebEvent; touchId?: string } = {}): AttributionTouch {
  const input = required.event ?? event();
  return { touchId: required.touchId ?? "touch", eventId: input.eventId, occurredAt: input.occurredAt, linkId: typeof input.properties.linkId === "string" ? input.properties.linkId : null, campaignId: typeof input.properties.campaignId === "string" ? input.properties.campaignId : null, clickIdentifiers: { ...Object.fromEntries(Object.entries(input.properties).filter(([key]) => ["gclid", "gbraid", "wbraid", "fbclid"].includes(key))) as Record<string, string>, ...contextPair({ event: input }) } };
}
/** Expected server-captured pair: both keys or neither; URL without query/fragment. */
function contextPair(required: { event: WebEvent }): Record<string, string> {
  const { client_user_agent: agent, pageUrl } = required.event.properties;
  if (typeof agent !== "string" || typeof pageUrl !== "string") return {};
  const page = new URL(pageUrl);
  return { client_user_agent: agent, event_source_url: page.origin + page.pathname };
}
export function clockFixture(): { clock: ClockPort; time: { now: number } } {
  const time = { now: 1000 };
  return { time, clock: { now: () => time.now } };
}
export function idsFixture(): IdPort {
  let sequence = 0;
  return { next: () => "generated-" + ++sequence };
}
export function tokenFixture(required: { result?: Outcome<Visit> } = {}): VisitTokenPort {
  return { async verify() { return required.result ?? { ok: true, value: visit }; } };
}
export function authorityFixture(required: { allowed?: boolean } = {}): CollectionAuthorityPort {
  return { async assess() { return { ok: true, value: { allowed: required.allowed ?? true } }; } };
}

/** Feature migration over the shared checked SQLite transaction/session fixture. */
export function sqliteFixture() {
  const fixture = createSqliteFixture({ migrations: [readFileSync(new URL("../migrations/0001_web_events.sql", import.meta.url), "utf8")] });
  return { db: fixture.native, pool: fixture.database, close: fixture.close };
}
