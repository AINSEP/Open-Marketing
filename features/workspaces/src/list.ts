/** Scoped listing of provisioned workspaces; it cannot broaden a run's workspace authority. */
import { z } from "zod";
import { callContextSchema, pageQuerySchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, CallOptions, ObserverPort, Outcome, Page, PageQuery, Scope } from "@open-marketing/contracts";
import { workspaceScopeSchema } from "./schemas.js";
import { failure } from "./rules.js";
import type { WorkspaceSqlDatabase } from "./sql.js";
/** A run sees its current provisioned workspace; enumeration cannot broaden workspace authority. */
export interface WorkspaceListing {
    list(required: { context: CallContext; query: PageQuery }, optional?: CallOptions): Promise<Outcome<Page<Scope>>>;
}
const inputSchema = z.strictObject({ context: callContextSchema, query: pageQuerySchema });
/** List only the authenticated workspace, with bounded pagination and parsed storage output.
 * @complexity O(1) indexed lookup; at most one scope is visible to this context. */
function listing(required: { read: (required: { scope: Scope }) => Promise<readonly Scope[]>; observer: ObserverPort }): WorkspaceListing {
    return { async list(input, optional) {
        const parsed = parseBoundary({ schema: inputSchema, input });
        if (!parsed.ok) return parsed;
        if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Workspace list cancelled" });
        const { context, query } = parsed.value;
        if (context.principal.kind === "owner" && context.principal.ownerId !== context.scope.ownerId) return failure({ code: "forbidden", message: "Workspace owner mismatch" });
        let result: Outcome<Page<Scope>>;
        try {
            const scopes = z.array(workspaceScopeSchema).max(1).parse(await required.read({ scope: context.scope }));
            const items = scopes.filter(scope => scope.ownerId === context.scope.ownerId && scope.workspaceId === context.scope.workspaceId && scope.workspaceId > (query.cursor ?? ""));
            result = { ok: true, value: { items, cursor: null } };
        } catch { result = failure({ code: "unavailable", message: "Workspace listing unavailable" }); }
        try { required.observer.observe({ operation: "workspaces.list", outcome: result.ok ? "ok" : result.error.code,
            correlationId: context.correlationId, traceId: context.traceId, runId: context.runId }); } catch { /* Read diagnostics cannot grant authority. */ }
        return result;
    } };
}
/** Read existing provisioned rows; no session, connection or service is constructed. */
export function createSqlWorkspaceListing(required: { db: WorkspaceSqlDatabase; observer: ObserverPort }): WorkspaceListing {
    return listing({ observer: required.observer, async read({ scope }) {
        const result = await required.db.query({ text: "SELECT owner_id, workspace_id FROM workspace WHERE owner_id=$1 AND workspace_id=$2 LIMIT 1", values: [scope.ownerId, scope.workspaceId] });
        const rows = z.array(z.strictObject({ owner_id: z.string(), workspace_id: z.string() })).max(1).parse(result.rows);
        return rows.map(row => ({ ownerId: row.owner_id, workspaceId: row.workspace_id }));
    } });
}
/** Detached, immutable provisioned rows are the read-only SQL adapter double. */
export function createMemoryWorkspaceListing(required: { workspaces: readonly Scope[]; observer: ObserverPort }): WorkspaceListing {
    const workspaces = z.array(workspaceScopeSchema).max(10000).parse(required.workspaces);
    return listing({ observer: required.observer, async read({ scope }) {
        return workspaces.filter(item => item.ownerId === scope.ownerId && item.workspaceId === scope.workspaceId).slice(0, 1);
    } });
}
