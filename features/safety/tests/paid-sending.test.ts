import { describe, expect, it } from "vitest";
import { createMemoryPaidSendingAllowances, createSqlPaidSendingAllowances } from "../index.js";
import { context, otherContext, sqliteFixture, unwrap } from "./fixtures.js";
for (const adapter of ["memory", "sql"] as const) describe("paid sending settings shared suite / " + adapter, () => {
    it("defaults to $5/day, isolates scopes and rejects stale concurrent edits", async () => {
        const sql = adapter === "sql" ? sqliteFixture({}) : undefined;
        const observer = { observe() {} };
        const settings = sql ? createSqlPaidSendingAllowances({ db: sql.port, clock: { now: () => 1000 }, observer, timezone: "UTC" }) : createMemoryPaidSendingAllowances({ observer, timezone: "UTC" });
        try {
            const initial = unwrap({ outcome: await settings.get({ context }) });
            expect(initial).toEqual({ dailyLimit: { currency: "USD", minorUnits: 500 }, timezone: "UTC", revision: 0 });
            const edit = { ...initial, dailyLimit: { currency: "USD", minorUnits: 700 } };
            const results = await Promise.all([settings.set({ context, settings: edit }), settings.set({ context, settings: edit })]);
            expect(results.filter(result => result.ok)).toHaveLength(1);
            expect(results.find(result => !result.ok)).toMatchObject({ ok: false, error: { code: "conflict" } });
            expect(unwrap({ outcome: await settings.get({ context: otherContext }) })).toEqual(initial);
            expect(await settings.set({ context: { ...context, principal: { kind: "agent", runId: "run", agentInstanceId: "instance" } }, settings: { ...edit, revision: 1 } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
            expect(await settings.set({ context, settings: { ...edit, timezone: "invalid", revision: 1 } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
            if (sql) {
                const restarted = createSqlPaidSendingAllowances({ db: sql.port, clock: { now: () => 1000 }, observer, timezone: "UTC" });
                expect(unwrap({ outcome: await restarted.get({ context }) }).revision).toBe(1);
                sql.setJournalFailure({ fail: true });
                expect(await restarted.set({ context, settings: { ...edit, revision: 1 } })).toMatchObject({ ok: false, error: { code: "unavailable" } });
                expect(unwrap({ outcome: await restarted.get({ context }) }).revision).toBe(1);
            }
        } finally { sql?.close(); }
    });
});
