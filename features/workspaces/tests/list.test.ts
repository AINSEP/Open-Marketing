import { describe, expect, it } from "vitest";
import { createMemoryWorkspaceListing, createSqlWorkspaceListing } from "../index.js";
import type { CallContext } from "@open-marketing/contracts";
import { createSqlHarness } from "./sql-fixture.js";
import { ownerScope, secondScope, otherScope, workspaces } from "./fixtures.js";
for (const adapter of ["memory", "sql"] as const) describe("workspace listing shared suite / " + adapter, () => {
    it("lists only the authenticated workspace, preserving owner and run scope", async () => {
        const sql = adapter === "sql" ? createSqlHarness({}) : undefined;
        const observer = { observe() {} };
        const listing = sql ? createSqlWorkspaceListing({ db: sql.db, observer }) : createMemoryWorkspaceListing({ workspaces, observer });
        try {
            for (const scope of [ownerScope, secondScope, otherScope]) {
                const context: CallContext = { scope, principal: { kind: "owner", ownerId: scope.ownerId }, correlationId: "correlation", traceId: "trace" };
                expect(await listing.list({ context, query: { limit: 100 } })).toEqual({ ok: true, value: { items: [scope], cursor: null } });
                expect(await listing.list({ context, query: { limit: 1, cursor: scope.workspaceId } })).toEqual({ ok: true, value: { items: [], cursor: null } });
                expect(await listing.list({ context: { ...context, principal: { kind: "owner", ownerId: "wrong" } }, query: { limit: 100 } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
            }
        } finally { sql?.dispose(); }
    });
});
