import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import type { CallContext, ClockPort, IdPort, Outcome, SqlSession, UnitOfWork } from "@open-marketing/contracts";
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

/** Test-only SQLite transaction owner. Failed root Outcomes roll back; sessions join. */
export function sqliteFixture(): { db: Database.Database; pool: UnitOfWork; close: () => void } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(readFileSync(new URL("../migrations/0001_web_events.sql", import.meta.url), "utf8"));
  let tail: Promise<unknown> = Promise.resolve();
  const pool: UnitOfWork = {
    async transaction({ work }) {
      const pending = tail.then(async () => {
        db.exec("BEGIN IMMEDIATE");
        const lifetime = { active: true };
        try {
          const result = await work({ session: createSession({ db, lifetime }) });
          db.exec(isFailure({ result }) ? "ROLLBACK" : "COMMIT");
          return result;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        } finally { lifetime.active = false; }
      });
      tail = pending.catch(() => undefined);
      return pending;
    },
  };
  return { db, pool, close: () => db.close() };
}
function isFailure(required: { result: unknown }): boolean {
  return typeof required.result === "object" && required.result !== null && "ok" in required.result && required.result.ok === false;
}
/** Narrow fixture wrapper around better-sqlite3's foreign variadic binding ABI. */
function createSession(required: { db: Database.Database; lifetime: { active: boolean } }): SqlSession {
  return {
    async query<Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) {
      assertActive(required);
      const bindings: unknown[] = [];
      // RegExp.replace is a foreign callback ABI; repeated $n placeholders repeat their value.
      const text = input.text.replace(/\$(\d+)/g, (_match, index: string) => { bindings.push(input.values?.[Number(index) - 1]); return "?"; });
      const statement = required.db.prepare(text);
      if (statement.reader) return { rows: statement.all(...bindings) as Row[], rowCount: null };
      return { rows: [] as Row[], rowCount: statement.run(...bindings).changes };
    },
    async transaction({ work }) {
      assertActive(required);
      return work({ session: this });
    },
  };
}
function assertActive(required: { lifetime: { active: boolean } }): void {
  if (!required.lifetime.active) throw new Error("Session released");
}
