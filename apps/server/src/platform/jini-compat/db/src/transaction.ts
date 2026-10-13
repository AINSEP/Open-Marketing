import type { SqlSession } from '@open-marketing/contracts';
import type { StorageKernel } from '@jini-ai/db/kernel';
import { PgFoundationError, type PgClient, type PgEvent, type PgObserver, type PgPool, type PgQueryable, type QueryResult } from './ports.js';
/** PostgreSQL statement/lock limits are transaction-local. SQLite's sync driver cannot enforce a
 * statement deadline here: configure native busy_timeout at composition and bound trusted SQL/body work.
 * Explicit SQLite timeout overrides are rejected rather than silently ignored.
 */
export interface TransactionOptions {
    statementTimeoutMs?: number;
    lockTimeoutMs?: number;
    observer?: PgObserver;
}
/** Runs an effect without allowing instrumentation failure to affect its result.
 * @complexity O(1) overhead, excluding the injected operation.
 */
async function observed<T>({ operation, observer, work }: {
    operation: PgEvent['operation'];
    observer: PgObserver | undefined;
    work: () => Promise<T>;
}): Promise<T> {
    emit({ observer: observer, event: { operation, status: 'started' } });
    try {
        const value = await work();
        emit({ observer: observer, event: { operation, status: 'succeeded' } });
        return value;
    }
    catch (cause) {
        emit({ observer: observer, event: { operation, status: 'failed' } });
        throw cause;
    }
}
/** Best-effort diagnostic hook; sink failure must not cause duplicate committed work.
 * @complexity O(1), excluding observer.
 */
function emit({ observer, event }: {
    observer: PgObserver | undefined;
    event: PgEvent;
}): void {
    try {
        observer?.(event);
    }
    catch { /* Telemetry is deliberately outside transaction correctness. */ }
}
/** Reject invalid timeouts before acquiring a connection.
 * @complexity O(1).
 */
function timeout({ value }: {
    value: number;
}): string {
    if (!Number.isInteger(value) || value < 1 || value > 3600000) {
        throw new PgFoundationError({ code: 'invalid_timeout', message: 'Timeout must be an integer from 1 to 3600000 milliseconds' });
    }
    return String(value);
}
/** Validate configuration before acquiring a lease; SQLite requires its owning kernel. */
function transactionLimits(required: { pool: PgPool; statementTimeoutMs: number; lockTimeoutMs: number }): string[] {
    const { pool, statementTimeoutMs, lockTimeoutMs } = required;
    if (pool.dialect === 'sqlite' && (statementTimeoutMs !== 30000 || lockTimeoutMs !== 5000)) {
        throw new PgFoundationError({ code: 'unsupported_timeout', message: 'Configure SQLite native timeouts at composition; per-transaction overrides are unsupported' });
    }
    if (pool.dialect === 'sqlite' && !pool.kernel) {
        throw new PgFoundationError({ code: 'kernel_required', message: 'SQLite composition must inject its owning Jini kernel' });
    }
    return [timeout({ value: statementTimeoutMs }), timeout({ value: lockTimeoutMs })];
}
/** Explicit external query edge; original driver errors stay in cause, not telemetry.
 * @complexity One query, O(1) wrapper space excluding results.
 */
function instrumentClient({ client, observer, lifetime }: {
    client: PgClient;
    observer?: PgObserver;
    lifetime: { active: boolean };
}): PgQueryable & SqlSession {
    return {
        async query<Row extends Record<string, unknown>>({ text, values, script }: {
            text: string;
            values?: unknown[];
            script?: true;
        }): Promise<QueryResult<Row>> {
            assertActive({ lifetime });
            try {
                return await observed({ operation: 'query', observer: observer, work: () => client.query<Row>({ text: text, values: values, script }) });
            }
            catch (cause) {
                if (cause instanceof PgFoundationError) throw cause;
                throw new PgFoundationError({ code: 'query_failed', message: 'Database query failed', options: { cause } });
            }
        },
        async transaction({ work }) {
            assertActive({ lifetime });
            return work({ session: this });
        },
    };
}
/** A retained session must never reach a later request. @complexity O(1). */
function assertActive(required: { lifetime: { active: boolean } }): void {
    if (!required.lifetime.active) throw new PgFoundationError({ code: 'connection_released', message: 'Transaction session has ended' });
}
/** Structural Outcome detection leaves non-Outcome return values unchanged. @complexity O(1). */
function failedOutcome(required: { value: unknown }): boolean {
    return typeof required.value === 'object' && required.value !== null && 'ok' in required.value && required.value.ok === false;
}
/** Roll back work failure, retaining both causes when cleanup also fails.
 * @complexity One query, O(1) space.
 */
async function rollback({ queryable, cause }: {
    queryable: PgQueryable;
    cause: unknown;
}): Promise<never> {
    try {
        await queryable.query({ text: 'ROLLBACK' });
    }
    catch (cleanup) {
        throw new PgFoundationError({ code: 'rollback_failed', message: 'Transaction and rollback failed', options: {
                cause: new AggregateError([cause, cleanup]),
            } });
    }
    throw new PgFoundationError({ code: 'transaction_failed', message: 'Transaction rolled back', options: { cause } });
}
/** Executes a bounded, sequential body; callers must await all work and never issue transaction control SQL.
 * @complexity Body-dependent plus constant transaction queries.
 *
 */
async function runBody<T>({ queryable, work, limits }: {
    queryable: PgQueryable & SqlSession;
    work: (tx: PgQueryable & SqlSession) => Promise<T>;
    limits: string[] | undefined;
}): Promise<T> {
    try {
        if (limits) await queryable.query({ text: "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)", values: limits });
        return await work(queryable);
    }
    catch (cause) {
        return rollback({ queryable: queryable, cause: cause });
    }
}
/** Execute and commit work on one connection. Body throws and returned failed Outcomes roll back; uncertain commits evict the client
 * and are NEVER retried. A callback must not retain the client, issue BEGIN/COMMIT, or launch unawaited work.
 * @example await withTransaction({ pool, work: tx => tx.query({ text: 'SELECT $1 AS value', values: [1] }) });
 * @returns Original callback value after commit or successful denial rollback. Nested session calls join; the outer caller decides the final Outcome.
 * @throws PgFoundationError with a cause; commit_failed means the outcome may be committed.
 * @complexity O(q) driver calls for q body queries; constant wrapper space.
 *
 *
 */
export async function withTransaction<T>({ pool, work }: {
    pool: PgPool;
    work: (tx: PgQueryable & SqlSession) => Promise<T>;
}, { statementTimeoutMs = 30000, lockTimeoutMs = 5000, observer }: TransactionOptions = {}): Promise<T> {
    const limits = transactionLimits({ pool, statementTimeoutMs, lockTimeoutMs });
    let client: PgClient;
    try {
        client = await observed({ operation: 'connect', observer: observer, work: () => pool.connect() });
    }
    catch (cause) {
        throw new PgFoundationError({ code: 'connect_failed', message: 'Database connection failed', options: { cause } });
    }
    const lifetime = { active: true };
    const queryable = instrumentClient({ client, observer, lifetime });
    let destroy = true;
    let primaryFailure: unknown;
    try {
        const result = pool.dialect === 'sqlite'
            ? await kernelTransaction({ kernel: pool.kernel!, queryable, work })
            : await postgresTransaction({ queryable, work, limits });
        if (failedOutcome({ value: result })) primaryFailure = result;
        destroy = false;
        return result;
    }
    catch (cause) {
        primaryFailure = cause;
        if (cause instanceof PgFoundationError && cause.code === 'transaction_failed')
            destroy = false;
        throw cause;
    }
    finally {
        lifetime.active = false;
        await releaseClient({ client, destroy, primaryFailure, observer });
    }
}

/** Private signal: a returned denial must reach the kernel's rollback path before being restored. */
class OutcomeRollback {
    readonly value: unknown;
    constructor({ value }: { value: unknown }) { this.value = value; }
}

/** Delegate all SQLite control to the injected kernel. Only a successfully rolled-back denial returns.
 * Foreign kernel callbacks are positional by StorageKernel ABI. A failed cleanup keeps both causes.
 * @complexity O(q) body queries; O(1) wrapper space. Nested repository calls use the same kernel.
 */
async function kernelTransaction<T>(required: { kernel: StorageKernel<unknown>; queryable: PgQueryable & SqlSession; work: (tx: PgQueryable & SqlSession) => Promise<T> }): Promise<T> {
    let denial: OutcomeRollback | undefined;
    const state: { failure?: unknown } = {};
    try {
        return await required.kernel.transaction(async () => {
            const result = await kernelBody({ ...required, state });
            if (failedOutcome({ value: result })) {
                denial = new OutcomeRollback({ value: result });
                throw denial;
            }
            return result;
        });
    } catch (cause) {
        if (denial && cause === denial) return denial.value as T;
        const primaryFailure = denial?.value ?? state.failure;
        if (cause instanceof PgFoundationError && cause.code === 'rollback_failed' && primaryFailure !== undefined) {
            throw new PgFoundationError({ code: 'rollback_failed', message: 'Transaction and kernel rollback failed', options: { cause: new AggregateError([primaryFailure, cause]) } });
        }
        if (cause instanceof PgFoundationError) throw cause;
        throw new PgFoundationError({ code: 'kernel_failed', message: 'Kernel transaction failed; reconcile before retry', options: { cause } });
    }
}

/** Preserve body failure separately from kernel cleanup failure; neither path retries work. */
async function kernelBody<T>(required: { queryable: PgQueryable & SqlSession; work: (tx: PgQueryable & SqlSession) => Promise<T>; state: { failure?: unknown } }): Promise<T> {
    try { return await required.work(required.queryable); }
    catch (cause) {
        required.state.failure = cause;
        throw new PgFoundationError({ code: 'transaction_failed', message: 'Transaction body failed; kernel rolls back', options: { cause } });
    }
}

/** Retained driver-free PostgreSQL compatibility path; SQLite never uses these control statements. */
async function postgresTransaction<T>(required: { queryable: PgQueryable & SqlSession; work: (tx: PgQueryable & SqlSession) => Promise<T>; limits: string[] }): Promise<T> {
    await required.queryable.query({ text: 'BEGIN' });
    const result = await runBody(required);
    await finishTransaction({ queryable: required.queryable, result });
    return result;
}

/** Returned denials roll back; commit failures stay uncertain and are never retried.
 * @complexity One query, O(1) space.
 */
async function finishTransaction(required: { queryable: PgQueryable; result: unknown }): Promise<void> {
    const denied = failedOutcome({ value: required.result });
    try {
        await required.queryable.query({ text: denied ? 'ROLLBACK' : 'COMMIT' });
    } catch (cause) {
        throw new PgFoundationError({
            code: denied ? 'rollback_failed' : 'commit_failed',
            message: denied ? 'Outcome rollback failed' : 'Commit outcome is uncertain; reconcile before retry',
            options: { cause },
        });
    }
}

/** Preserve committed/failed outcome precedence even when connection release also fails. */
async function releaseClient(required: { client: PgClient; destroy: boolean; primaryFailure: unknown; observer: PgObserver | undefined }): Promise<void> {
 const { client, destroy, primaryFailure, observer } = required;
        try {
            await observed({ operation: 'release', observer: observer, work: async () => client.release({ destroy: destroy || undefined }) });
        }
        catch (cleanup) {
            if (primaryFailure) {
                throw new PgFoundationError({ code: 'release_after_failure', message: 'Transaction failed and connection release also failed', options: {
                        cause: new AggregateError([primaryFailure, cleanup]),
                    } });
            }
            throw new PgFoundationError({ code: 'release_after_commit', message: 'Transaction COMMITTED but release failed; do not retry work', options: { cause: cleanup } });
        }
}
