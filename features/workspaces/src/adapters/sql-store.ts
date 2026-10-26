import type { IdPort } from "@open-marketing/contracts";
import type { IdentityPort, WorkspaceObserverPort } from "../ports.js";
import type { WorkspaceRepository } from "../store.js";
import { createRepository } from "../repository.js";
import { z } from "zod";
import { idSchema } from "@open-marketing/contracts";
import type { Scope } from "@open-marketing/contracts";
import type { AccountBinding } from "../types.js";
import type { WorkspaceStore } from "../store.js";
import { failure, sameBinding } from "../rules.js";
import type { WorkspaceSqlDatabase, WorkspaceSqlSession } from "../sql.js";

const bindingRowSchema = z.strictObject({ id: idSchema, owner_id: idSchema, workspace_id: idSchema, connection_id: idSchema, external_account_id: idSchema });
const existsRowSchema = z.strictObject({ found: z.literal(1) });

/** Decode bounded SQL output; bad driver/row shapes throw into the typed repository boundary. @complexity O(1). */
function readBinding(required: { rows: readonly unknown[] }): AccountBinding | null {
  const rows = z.array(bindingRowSchema).max(1).parse(required.rows);
  const row = rows[0];
  return row ? { id: row.id, scope: { ownerId: row.owner_id, workspaceId: row.workspace_id }, connectionId: row.connection_id, externalAccountId: row.external_account_id } : null;
}

/** Parameterized account lookup, always qualified by full scope. @complexity O(log n) with indexes. */
async function findBinding(required: { db: WorkspaceSqlSession; scope: Scope; externalAccountId: string }): Promise<AccountBinding | null> {
  const result = await required.db.query({ text: "SELECT id, owner_id, workspace_id, connection_id, external_account_id FROM workspace_account_binding WHERE owner_id = $1 AND workspace_id = $2 AND external_account_id = $3 LIMIT 1", values: [required.scope.ownerId, required.scope.workspaceId, required.externalAccountId] });
  return readBinding(result);
}

/** Ownership checks and insertion happen in one serialized write transaction. Constraints arbitrate
 * concurrent writers; ON CONFLICT does not overwrite an existing binding. @complexity O(log n), fixed query count.
 */
async function bindTransaction(required: { db: WorkspaceSqlSession; binding: AccountBinding }) {
  const { binding, db } = required;
  const ownership = await db.query({ text: "SELECT 1 AS found FROM workspace_connection_scope WHERE owner_id = $1 AND workspace_id = $2 AND connection_id = $3 LIMIT 1", values: [binding.scope.ownerId, binding.scope.workspaceId, binding.connectionId] });
  if (z.array(existsRowSchema).max(1).parse(ownership.rows).length === 0) return failure<AccountBinding>({ code: "forbidden", message: "Connection is not owned by this workspace" });
  await db.query({ text: "INSERT INTO workspace_account_binding (id, owner_id, workspace_id, connection_id, external_account_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING", values: [binding.id, binding.scope.ownerId, binding.scope.workspaceId, binding.connectionId, binding.externalAccountId] });
  const byAccount = await findBinding({ db, scope: binding.scope, externalAccountId: binding.externalAccountId });
  if (!byAccount || !sameBinding({ left: byAccount, right: binding })) return failure<AccountBinding>({ code: "conflict", message: "Account binding conflicts with an existing binding" });
  return { ok: true as const, value: byAccount };
}

/** SQL store uses only the injected DB-shaped port; does not open a driver, provision authority,
 * migrate or start a service. @complexity O(1) construction, O(log n) indexed operations.
 */
export function createSqlStore(required: { db: WorkspaceSqlDatabase }): WorkspaceStore {
  return {
    async hasWorkspace({ scope }) {
      const result = await required.db.query({ text: "SELECT 1 AS found FROM workspace WHERE owner_id = $1 AND workspace_id = $2 LIMIT 1", values: [scope.ownerId, scope.workspaceId] });
      return z.array(existsRowSchema).max(1).parse(result.rows).length === 1;
    },
    async bind({ binding }) {
      return required.db.transaction({ work: ({ session }) => bindTransaction({ db: session, binding }) });
    },
    async find(input) { return findBinding({ db: required.db, ...input }); },
  };
}

/** Persistent adapter for both repository and scoped lookup. Factory is inert; migrations are
 * never applied here. @example createSqlWorkspaceRepo({ db: serverDbAdapter, identity, ids })
 * @complexity O(1) construction, fixed indexed SQL queries per operation.
 */
export function createSqlWorkspaceRepo(required: { db: WorkspaceSqlDatabase; identity: IdentityPort; ids: IdPort }, optional?: { observer?: WorkspaceObserverPort }): WorkspaceRepository {
  return createRepository({ store: createSqlStore({ db: required.db }), identity: required.identity, ids: required.ids }, optional);
}
