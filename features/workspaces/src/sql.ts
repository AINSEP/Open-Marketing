import { callPort } from "./boundary.js";
import { bindingSchema } from "./schemas.js";

/** Minimal @jini-ai/db-shaped query port; server adapts its SQLite shim. $n placeholders are
 * numbered parameters, never interpolated values. Returned rows are validated by the adapter.
 */
export interface WorkspaceSqlSession {
  query(required: { text: string; values?: unknown[] }): Promise<{ rows: readonly unknown[] }>;
}
/** Server owns transaction serialization, foreign-key enforcement, timeouts and cancellation.
 * run is a foreign callback ABI receiving the checked-out session. BEGIN IMMEDIATE on SQLite;
 * on Postgres use a transaction with FK checks/unique constraints. Roll back rejected/thrown work.
 */
export interface WorkspaceSqlDatabase extends WorkspaceSqlSession {
  transaction<T>(required: { run: (session: WorkspaceSqlSession) => Promise<T> }): Promise<T>;
}

/** Use the persistent repository's same scoped lookup boundary. @complexity O(1).
 * @example createSqlAccountBindingLookup({ repo: sqlRepo })
 */
export function createSqlAccountBindingLookup(required: { repo: import("./ports.js").AccountBindingLookupPort }): import("./ports.js").AccountBindingLookupPort {
  return { async find(input, optional) { return callPort({ invoke: () => required.repo.find(input, optional), schema: bindingSchema.nullable() }, optional); } };
}
