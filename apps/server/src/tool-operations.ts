/** Write-through snapshots, not a queue: only the dispatcher may invoke an operation. */
import type { CallContext, Outcome, Scope, SqlSession, UnitOfWork } from '@open-marketing/contracts';
import { idSchema, scopeSchema } from '@open-marketing/contracts';
import { storedToolOperationSchema } from './om-tool-types.js';
import type { StoredToolOperation } from './om-tool-types.js';
import { localFailure } from './composition/local-auth.js';

/** Awaited write-through persistence; adapters never invoke or replay operations. */
export interface ToolOperationStore {
    save(required: { context: CallContext; operation: StoredToolOperation }): Promise<Outcome<void>>;
    /** Compact a terminal body, retaining scope, digest and exact outcome for replay. */
    archive(required: { context: CallContext; operation: StoredToolOperation }): Promise<Outcome<void>>;
    /** Read one archived identity; it cannot supply dispatch or approval authority. */
    replay(required: { context: CallContext; operationId: string }): Promise<Outcome<StoredToolOperation | null>>;
    /** Includes at most 256 full bodies, oldest first; archives are read individually. */
    loadOpen(required: { scope: Scope }): Promise<Outcome<readonly StoredToolOperation[]>>;
}
/** Remove reviewed arguments/cards only after an operation is terminal. Results remain exact.
 * The retained digest covers the original entire call, including its idempotency key.
 */
export function compactToolOperation(required: { operation: StoredToolOperation }): StoredToolOperation {
    const operation = required.operation;
    if (operation.state.status === 'pending' || operation.executing) throw new Error('Cannot archive an active operation');
    return { ...operation, call: { ...operation.call, input: {} }, card: undefined, approvalId: undefined, grantChoice: undefined,
        request: { ...operation.request, arguments: {}, generation: undefined } };
}
/** Parse both adapters' snapshots; invalid storage cannot restore dispatch authority. @complexity O(b), b <=256KiB. */
function decode(required: { payload: unknown; scope: Scope; operationId?: string }): StoredToolOperation {
    if (typeof required.payload !== 'string' || Buffer.byteLength(required.payload) > 262144) throw new Error('Operation payload exceeds bound');
    const operation = storedToolOperationSchema.parse(JSON.parse(required.payload));
    if (operation.context.scope.ownerId !== required.scope.ownerId || operation.context.scope.workspaceId !== required.scope.workspaceId
        || operation.call.operationId !== operation.state.operationId) throw new Error('Operation scope/identity mismatch');
    if (required.operationId && operation.call.operationId !== required.operationId) throw new Error('Operation key mismatch');
    return operation;
}
/** Storage errors never imply retry authority. @complexity O(1). */
function unavailable<T>(): Outcome<T> {
    return { ok: false, error: { code: 'unavailable', message: 'Tool operation storage unavailable; reconcile before retrying', retryable: false } };
}
/** Preserve insertion order on updates, including compaction. One indexed scope sequence read
 * and one upsert in the caller's transaction; no transaction spans tool invocation.
 */
async function writeSnapshot(required: { session: SqlSession; context: CallContext; operation: StoredToolOperation; status: string }): Promise<void> {
    const { operation } = required;
    await required.session.query({ text: 'INSERT INTO server_tool_operations (owner_id, workspace_id, operation_id, status, card_id, payload, retention_order) VALUES ($1,$2,$3,$4,$5,$6,(SELECT COALESCE(MAX(retention_order),0)+1 FROM server_tool_operations WHERE owner_id=$1 AND workspace_id=$2)) ON CONFLICT (owner_id, workspace_id, operation_id) DO UPDATE SET status=excluded.status, card_id=excluded.card_id, payload=excluded.payload',
        values: [required.context.scope.ownerId, required.context.scope.workspaceId, operation.call.operationId, required.status, operation.card?.cardId ?? null, JSON.stringify(operation)] });
}
/** Portable SQL upserts on the one server transaction owner. Retains <=256 full bodies per scope.
 * @example const store = createSqlToolOperationStore({ unit });
 * @complexity O(b) per save and O(n*b) per bounded load, n <=256, b <=256KiB.
 */
export function createSqlToolOperationStore(required: { unit: UnitOfWork }): ToolOperationStore {
    return {
        async save(input): Promise<Outcome<void>> {
            try {
                const operation = decode({ payload: JSON.stringify(input.operation), scope: input.context.scope });
                return await required.unit.transaction<Outcome<void>>({ work: async ({ session }) => {
                    const values = [input.context.scope.ownerId, input.context.scope.workspaceId, operation.call.operationId];
                    const count = await session.query({ text: "SELECT COUNT(*) AS total FROM server_tool_operations WHERE owner_id=$1 AND workspace_id=$2 AND operation_id<>$3 AND status<>'replay'", values });
                    const total = Number(count.rows[0]?.total);
                    if (!Number.isSafeInteger(total) || total < 0) return unavailable();
                    if (total >= 256) return localFailure({ code: 'limit_exceeded', message: 'Tool operation storage capacity reached' });
                    const status = operation.executing && operation.state.status === 'pending' ? 'dispatching' : operation.state.status;
                    await writeSnapshot({ session, context: input.context, operation, status });
                    return { ok: true, value: undefined };
                } });
            } catch { return unavailable(); }
        },
        async archive(input): Promise<Outcome<void>> {
            try {
                const operation = decode({ payload: JSON.stringify(compactToolOperation(input)), scope: input.context.scope });
                return await required.unit.transaction<Outcome<void>>({ work: async ({ session }) => {
                    await writeSnapshot({ session, context: input.context, operation, status: 'replay' });
                    return { ok: true, value: undefined };
                } });
            } catch { return unavailable(); }
        },
        async replay(input): Promise<Outcome<StoredToolOperation | null>> {
            try {
                scopeSchema.parse(input.context.scope); idSchema.parse(input.operationId);
                return await required.unit.transaction<Outcome<StoredToolOperation | null>>({ work: async ({ session }) => {
                    const result = await session.query({ text: "SELECT payload FROM server_tool_operations WHERE owner_id=$1 AND workspace_id=$2 AND operation_id=$3 AND status='replay'",
                        values: [input.context.scope.ownerId, input.context.scope.workspaceId, input.operationId] });
                    if (!result.rows.length) return { ok: true, value: null };
                    return { ok: true, value: compactToolOperation({ operation: decode({ payload: result.rows[0].payload, scope: input.context.scope, operationId: input.operationId }) }) };
                } });
            } catch { return unavailable(); }
        },
        async loadOpen(input): Promise<Outcome<readonly StoredToolOperation[]>> {
            try {
                scopeSchema.parse(input.scope);
                return await required.unit.transaction<Outcome<readonly StoredToolOperation[]>>({ work: async ({ session }) => {
                    const result = await session.query({ text: "SELECT payload FROM server_tool_operations WHERE owner_id=$1 AND workspace_id=$2 AND status<>'replay' ORDER BY retention_order LIMIT 257", values: [input.scope.ownerId, input.scope.workspaceId] });
                    if (result.rows.length > 256) return localFailure({ code: 'limit_exceeded', message: 'Tool operation restore capacity reached' });
                    return { ok: true, value: result.rows.map(row => decode({ payload: row.payload, scope: input.scope })) };
                } });
            } catch { return unavailable(); }
        },
    };
}
/** Storage double snapshots values on save/load, so reopening a dispatcher cannot mutate storage.
 * @example const store = createMemoryToolOperationStore({});
 * @complexity O(n*b), n <=256 records/scope, b <=256KiB.
 */
export function createMemoryToolOperationStore(_required: Record<string, never>): ToolOperationStore {
    const records = new Map<string, string>();
    const archives = new Map<string, string>();
    return {
        async save(input): Promise<Outcome<void>> {
            try {
                const operation = decode({ payload: JSON.stringify(input.operation), scope: input.context.scope });
                const prefix = JSON.stringify([input.context.scope.ownerId, input.context.scope.workspaceId]);
                const key = prefix + operation.call.operationId;
                if (!records.has(key) && [...records.keys()].filter(value => value.startsWith(prefix)).length >= 256)
                    return localFailure({ code: 'limit_exceeded', message: 'Tool operation storage capacity reached' });
                records.set(key, JSON.stringify(operation)); archives.delete(key);
                return { ok: true, value: undefined };
            } catch { return unavailable(); }
        },
        async archive(input): Promise<Outcome<void>> {
            try {
                const operation = decode({ payload: JSON.stringify(compactToolOperation(input)), scope: input.context.scope });
                const key = JSON.stringify([input.context.scope.ownerId, input.context.scope.workspaceId]) + operation.call.operationId;
                archives.set(key, JSON.stringify(operation)); records.delete(key);
                return { ok: true, value: undefined };
            } catch { return unavailable(); }
        },
        async replay(input): Promise<Outcome<StoredToolOperation | null>> {
            try {
                scopeSchema.parse(input.context.scope); idSchema.parse(input.operationId);
                const key = JSON.stringify([input.context.scope.ownerId, input.context.scope.workspaceId]) + input.operationId;
                const payload = archives.get(key);
                return { ok: true, value: payload ? decode({ payload, scope: input.context.scope, operationId: input.operationId }) : null };
            } catch { return unavailable(); }
        },
        async loadOpen(input): Promise<Outcome<readonly StoredToolOperation[]>> {
            try {
                scopeSchema.parse(input.scope);
                const prefix = JSON.stringify([input.scope.ownerId, input.scope.workspaceId]);
                return { ok: true, value: [...records].filter(([key]) => key.startsWith(prefix)).map(([, payload]) => decode({ payload, scope: input.scope })) };
            } catch { return unavailable(); }
        },
    };
}
