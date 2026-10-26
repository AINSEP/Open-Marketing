import { createSqliteFixture } from "@open-marketing/om-db/testing";
import { readFileSync } from "node:fs";
import type { CallContext, ClockPort, IdPort, Outcome } from "@open-marketing/contracts";
import type { AttributionTouch, CollectionAuthorityPort, Visit, VisitTokenPort, WebEvent } from "../index.js";

export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const otherWorkspace: CallContext = { ...context, scope: { ...context.scope, workspaceId: "other-workspace" } };
export const otherOwner: CallContext = { ...context, scope: { ...context.scope, ownerId: "other-owner" }, principal: { kind: "owner", ownerId: "other-owner" } };
export const visit: Visit = { visitId: "visit", scope: context.scope, anonymousId: "anonymous", subjectId: null, expiresAt: 2000 };

export function event(required: Partial<WebEvent> = {}): WebEvent {
  return { eventId: "event", schema: "om.web.landing", version: 1, source: "first-party", anonymousId: "anonymous", name: "landing", properties: { linkId: "link", campaignId: "campaign", gclid: "google-click", fbclid: "meta-click" }, occurredAt: 100, receivedAt: 0, cursor: 0, traceId: "trace", ...required };
}
export function touch(required: { event?: WebEvent; touchId?: string } = {}): AttributionTouch {
  const input = required.event ?? event();
  return { touchId: required.touchId ?? "touch", eventId: input.eventId, occurredAt: input.occurredAt, linkId: typeof input.properties.linkId === "string" ? input.properties.linkId : null, campaignId: typeof input.properties.campaignId === "string" ? input.properties.campaignId : null, clickIdentifiers: Object.fromEntries(Object.entries(input.properties).filter(([key]) => ["gclid", "gbraid", "wbraid", "fbclid"].includes(key))) as Record<string, string> };
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
