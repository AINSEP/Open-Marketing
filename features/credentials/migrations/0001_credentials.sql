-- Additive feature-owned schema. Apply only through the server migration runner.
CREATE TABLE IF NOT EXISTS om_credential_connection (
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('connected', 'revoked', 'reconnect_required')),
  version INTEGER NOT NULL CHECK (version > 0),
  ciphertext TEXT,
  aad_digest TEXT NOT NULL,
  revoked_at BIGINT,
  PRIMARY KEY (owner_id, workspace_id, connection_id),
  CHECK (status = 'revoked' OR ciphertext IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS om_credential_audit (
  event_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  run_id TEXT,
  recorded_at BIGINT NOT NULL
);
