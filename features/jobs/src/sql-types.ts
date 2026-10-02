import type { CallContext } from "@open-marketing/contracts";
/** Removable @jini-ai/db-shaped query seam, implemented by the server's SQLite shim. All values use bound $n parameters. */
export interface JobsSqlSession {
    query(required: { sql: string; parameters: readonly unknown[] }): Promise<{ rows: readonly Readonly<Record<string, unknown>>[] }>;
}
/** MUST serialize all writers across connections (SQLite BEGIN IMMEDIATE; Postgres SERIALIZABLE with retry).
 * execute must use one connection, commit only after it resolves, and roll back on rejection, including domain intent writes.
 * No driver, clock, DB connection, or migration is constructed/applied by jobs.
 */
export interface JobsSqlDatabase {
    transaction<T>(required: { context?: CallContext; execute: (required: { session: JobsSqlSession }) => Promise<T> }): Promise<T>;
}
