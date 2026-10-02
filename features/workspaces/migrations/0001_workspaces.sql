-- Additive, feature-owned schema. Apply only through the server migration composition.
-- SQLite foreign_keys MUST be enabled by the server; all SQL is portable to PostgreSQL.
CREATE TABLE IF NOT EXISTS workspace (
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  PRIMARY KEY (owner_id, workspace_id)
);

-- This authority table is populated only from trusted server connection ownership.
-- It contains no credential/vendor configuration and is never populated by bindAccount.
CREATE TABLE IF NOT EXISTS workspace_connection_scope (
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  PRIMARY KEY (owner_id, workspace_id, connection_id),
  FOREIGN KEY (owner_id, workspace_id) REFERENCES workspace (owner_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS workspace_account_binding (
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  external_account_id TEXT NOT NULL,
  PRIMARY KEY (owner_id, workspace_id, id),
  UNIQUE (owner_id, workspace_id, external_account_id),
  FOREIGN KEY (owner_id, workspace_id, connection_id)
    REFERENCES workspace_connection_scope (owner_id, workspace_id, connection_id)
);
