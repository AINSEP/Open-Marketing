import type { CallContext, CallOptions, ObserverPort, Outcome } from "@open-marketing/contracts";
import type { AuditEntry, AuditPage, AuditQuery, AuditReceipt } from "./types.js";

/** Trusted server repository. Corrections require an existing same-scope, same-operation receipt.
 * Raw references are available only behind this boundary; appends are immutable.
 * @example await repo.append({ context, entry });
 */
export interface AuditRepoPort {
  append(required: { context: CallContext; entry: AuditEntry }, optional?: CallOptions): Promise<Outcome<AuditReceipt>>;
  list(required: { context: CallContext; query: AuditQuery }, optional?: CallOptions): Promise<Outcome<AuditPage>>;
}
/** Operational projection: preserve operation, kind, digest and correction lineage.
 * @example await redactor.redact({ context, entry });
 */
export interface AuditRedactorPort {
  redact(required: { context: CallContext; entry: AuditEntry }, optional?: CallOptions): Promise<Outcome<AuditEntry>>;
}
/** Diagnostics carry fixed labels and injected correlation IDs, never entries. */
export type AuditObserverPort = ObserverPort;

/** Removable Jini-shaped query seam: bound $n values, no driver construction.
 * @example await session.query({ text: "SELECT entry_id FROM audit_entry WHERE entry_id = $1", values: [id] });
 */
export interface AuditSqlSession {
  query(required: { text: string; values: unknown[] }): Promise<{ rows: readonly Readonly<Record<string, unknown>>[] }>;
}
/** Composition owns connections, busy timeout and lifecycle. Transactions serialize writers
 * (SQLite BEGIN IMMEDIATE), commit before returning and roll back callback exceptions.
 * Never retry uncertain commits. Forward signal to acquisition/query cancellation where supported.
 * @example await db.transaction({ context, execute: ({ session }) => session.query({ text, values }) });
 */
export interface AuditSqlDatabase {
  transaction<T>(required: {
    context: CallContext;
    execute: (required: { session: AuditSqlSession }) => Promise<T>;
  }, optional?: CallOptions): Promise<T>;
}
