import type { CallContext, CallOptions, Outcome, SqlSession, UnitOfWork } from "@open-marketing/contracts";
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
/** Canonical leased SQL session; audit validates tainted rows before use. */
export type AuditSqlSession = SqlSession;
/** Server owns serialized transactions, rollback and session lifetime. */
export type AuditSqlDatabase = UnitOfWork;
