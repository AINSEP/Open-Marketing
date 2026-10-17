import { describe, expect, it } from "vitest";
import { createMemoryPaidSendingAllowances, createSqlPaidSendingAllowances } from "../index.js";
import { context, otherContext, sqliteFixture, unwrap, timing } from "./fixtures.js";
for (const adapter of ["memory", "sql"] as const) describe("paid sending settings shared suite / " + adapter, () => {
    it("defaults to $5/day, isolates scopes and rejects stale concurrent edits", async () => {
        const sql = adapter === "sql" ? sqliteFixture({}) : undefined;
        const observer = { observe() {} };
        const settings = sql ? createSqlPaidSendingAllowances({ db: sql.port, clock: { now: () => 1000 }, observer, timezone: "UTC" }) : createMemoryPaidSendingAllowances({ clock: { now: () => 1000 }, observer, timezone: "UTC" });
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

/** One shared runtime suite exercises both adapters; no sender or provider is constructed. */
for (const adapter of ["memory", "sql"] as const) describe("paid sending accounting / " + adapter, () => {
    function fixture() {
        const time = timing({ now: Date.parse("2026-11-01T06:30:00Z") }); // LA Oct 31, before DST fallback.
        const sql = adapter === "sql" ? sqliteFixture({}) : undefined;
        const dependencies = { clock: time.clock, observer: { observe() {} }, timezone: "America/Los_Angeles" };
        const open = () => sql ? createSqlPaidSendingAllowances({ ...dependencies, db: sql.port }) : createMemoryPaidSendingAllowances(dependencies);
        return { time, sql, open, allowances: open(), close() { sql?.close(); } };
    }
    function request(required: { operationId: string; amount?: number; now: number }) {
        const argumentsDigest = "a".repeat(64);
        const amount = { currency: "USD", minorUnits: required.amount ?? 300 };
        return { context, operationId: required.operationId, argumentsDigest, quote: { quoteId: "quote:" + required.operationId,
            argumentsDigest, estimated: amount, upperBound: amount, pricingEvidenceId: "pricing", expiresAt: required.now + 172800000, status: "known" as const } };
    }
    it("serializes competing reserves, deduplicates operations and restores outstanding exposure", async () => {
        const f = fixture(); const now = f.time.clock.now({});
        const first = request({ operationId: "first", now }); const second = request({ operationId: "second", now });
        try {
            const results = await Promise.all([f.allowances.reserve(first), f.allowances.reserve(second)]);
            expect(results.filter(result => result.ok)).toHaveLength(1);
            expect(results.find(result => !result.ok)).toMatchObject({ error: { code: "forbidden", message: "exact_spend_required" } });
            const winner = results[0].ok ? first : second;
            const reservation = unwrap({ outcome: results.find(result => result.ok)! });
            expect(await f.allowances.reserve(winner)).toEqual({ ok: true, value: reservation });
            expect(await f.allowances.reserve({ ...winner, quote: { ...winner.quote, pricingEvidenceId: "changed" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
            expect(await f.allowances.reserve({ ...second, context: otherContext })).toMatchObject({ ok: true });
            if (f.sql) expect(await f.open().reserve(request({ operationId: "after-restart", now }))).toMatchObject({ ok: false, error: { message: "exact_spend_required" } });
        } finally { f.close(); }
    });
    it("resets settled charges at local midnight, retains pending costs, and uses the DST day", async () => {
        const f = fixture(); const now = f.time.clock.now({});
        try {
            const paid = unwrap({ outcome: await f.allowances.reserve(request({ operationId: "paid", amount: 400, now })) });
            unwrap({ outcome: await f.allowances.settle({ context, settlement: { reservationId: paid.reservationId, observationId: "cost", actual: { currency: "USD", minorUnits: 400 } } }) });
            unwrap({ outcome: await f.allowances.reserve(request({ operationId: "pending", amount: 100, now })) });
            f.time.setNow({ now: Date.parse("2026-11-01T06:59:59.999Z") });
            expect(await f.allowances.reserve(request({ operationId: "too-early", amount: 1, now }))).toMatchObject({ ok: false });
            f.time.setNow({ now: Date.parse("2026-11-01T07:00:00Z") });
            const nextDay = unwrap({ outcome: await f.allowances.reserve(request({ operationId: "next-day", amount: 400, now })) });
            expect(nextDay.dispatchDay).toBe("America/Los_Angeles:2026-11-01");
            unwrap({ outcome: await f.allowances.settle({ context, settlement: { reservationId: nextDay.reservationId, observationId: "next-cost", actual: nextDay.amount } }) });
            f.time.setNow({ now: Date.parse("2026-11-02T07:59:59.999Z") });
            expect(await f.allowances.reserve(request({ operationId: "still-same-day", amount: 1, now: f.time.clock.now({}) }))).toMatchObject({ ok: false });
            f.time.setNow({ now: Date.parse("2026-11-02T08:00:00Z") });
            expect(await f.allowances.reserve(request({ operationId: "after-dst-midnight", amount: 400, now: f.time.clock.now({}) }))).toMatchObject({ ok: true });
        } finally { f.close(); }
    });
    it("refuses unknown, expired, mismatched and incomparable quotes without consuming capacity", async () => {
        const f = fixture(); const input = request({ operationId: "quoted", amount: 500, now: f.time.clock.now({}) });
        try {
            for (const change of [{ status: "unknown" as const, upperBound: null }, { status: "expired" as const },
                { expiresAt: f.time.clock.now({}) }, { argumentsDigest: "b".repeat(64) }, { upperBound: { currency: "EUR", minorUnits: 500 } },
                { upperBound: { currency: "USD", minorUnits: 499 } }]) {
                expect(await f.allowances.reserve({ ...input, quote: { ...input.quote, ...change } })).toMatchObject({ ok: false, error: { code: "forbidden", message: "exact_spend_required" } });
            }
            expect(await f.allowances.reserve(input)).toMatchObject({ ok: true });
        } finally { f.close(); }
    });
    it("links immutable corrections and rejects stale evidence without freeing pending exposure", async () => {
        const f = fixture(); const now = f.time.clock.now({});
        try {
            const reservation = unwrap({ outcome: await f.allowances.reserve(request({ operationId: "sending", amount: 500, now })) });
            const settlement = { reservationId: reservation.reservationId, observationId: "observed", actual: { currency: "USD", minorUnits: 400 } };
            unwrap({ outcome: await f.allowances.settle({ context, settlement }) });
            expect(await f.allowances.settle({ context, settlement })).toEqual({ ok: true, value: undefined });
            expect(await f.allowances.settle({ context, settlement: { ...settlement, actual: { currency: "USD", minorUnits: 0 } } })).toMatchObject({ ok: false, error: { code: "conflict" } });
            expect(await f.allowances.settle({ context, settlement: { ...settlement, observationId: "unlinked" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
            unwrap({ outcome: await f.allowances.settle({ context, settlement: { ...settlement, observationId: "correction", correctsObservationId: "observed", actual: { currency: "USD", minorUnits: 300 } } }) });
            if (f.sql) {
                const journal = f.sql.db.prepare("SELECT payload FROM safety_journal WHERE kind='paid_sending_settle' ORDER BY sequence").all() as { payload: string }[];
                expect(JSON.parse(journal[0].payload).evidence.settlement).toEqual(settlement);
                expect(JSON.parse(journal.at(-1)!.payload).evidence.settlement).toEqual({ ...settlement, observationId: "correction", correctsObservationId: "observed", actual: { currency: "USD", minorUnits: 300 } });
            }
            expect(await f.allowances.reserve(request({ operationId: "remaining", amount: 200, now }))).toMatchObject({ ok: true });
            expect(await f.allowances.settle({ context: otherContext, settlement })).toMatchObject({ ok: false });
        } finally { f.close(); }
    });
    it("defers timezone edits until rollover and enforces the 1000-reservation bound", async () => {
        const f = fixture(); const now = f.time.clock.now({});
        try {
            unwrap({ outcome: await f.allowances.reserve(request({ operationId: "before-edit", amount: 500, now })) });
            const current = unwrap({ outcome: await f.allowances.get({ context }) });
            unwrap({ outcome: await f.allowances.set({ context, settings: { ...current, timezone: "UTC" } }) });
            expect(await f.allowances.reserve(request({ operationId: "same-cycle", amount: 1, now }))).toMatchObject({ ok: false });
            f.time.setNow({ now: Date.parse("2026-11-01T07:00:00Z") });
            const outstanding = { reservationId: "before-edit", observationId: "settled", actual: { currency: "USD", minorUnits: 500 } };
            unwrap({ outcome: await f.allowances.settle({ context, settlement: outstanding }) });
            expect(await f.allowances.reserve(request({ operationId: "new-zone", amount: 500, now }))).toMatchObject({ ok: true, value: { dispatchDay: "UTC:2026-11-01" } });
        } finally { f.close(); }
        const bounded = fixture();
        try {
            for (let index = 0; index < 1000; index++) unwrap({ outcome: await bounded.allowances.reserve(request({ operationId: "zero-" + index, amount: 0, now })) });
            expect(await bounded.allowances.reserve(request({ operationId: "overflow", amount: 0, now }))).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
        } finally { bounded.close(); }
    });
    it("rolls back both state and journal when financial evidence cannot append", async () => {
        const f = fixture();
        try {
            if (!f.sql) return;
            const input = request({ operationId: "atomic", amount: 500, now: f.time.clock.now({}) });
            f.sql.setJournalFailure({ fail: true });
            expect(await f.allowances.reserve(input)).toMatchObject({ ok: false, error: { code: "unavailable" } });
            f.sql.setJournalFailure({ fail: false });
            expect(unwrap({ outcome: await f.allowances.get({ context }) }).revision).toBe(0);
            expect(await f.allowances.reserve(input)).toMatchObject({ ok: true });
            const before = f.sql.db.prepare("SELECT sequence,kind FROM safety_journal ORDER BY sequence").all();
            f.sql.setJournalFailure({ fail: true });
            expect(await f.allowances.settle({ context, settlement: { reservationId: "atomic", observationId: "cost", actual: { currency: "USD", minorUnits: 0 } } })).toMatchObject({ ok: false });
            f.sql.setJournalFailure({ fail: false });
            expect(f.sql.db.prepare("SELECT sequence,kind FROM safety_journal ORDER BY sequence").all()).toEqual(before);
            expect(await f.open().reserve(request({ operationId: "still-reserved", amount: 1, now: f.time.clock.now({}) }))).toMatchObject({ ok: false });
        } finally { f.close(); }
    });
});
