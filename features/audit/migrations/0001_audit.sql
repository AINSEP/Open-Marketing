-- Additive feature-owned schema. The server migration runner applies it explicitly.
-- Core SQL is portable; BIGINT values must be normalized to safe JS numbers by the DB bridge.
CREATE TABLE IF NOT EXISTS audit_entry (
  entry_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  operation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('intent','approval','dispatch','outcome','correction')),
  arguments_digest TEXT NOT NULL,
  correction_of TEXT,
  recorded_at BIGINT NOT NULL CHECK (recorded_at >= 0),
  payload TEXT NOT NULL,
  context_json TEXT NOT NULL,
  UNIQUE (owner_id, workspace_id, sequence),
  UNIQUE (owner_id, workspace_id, operation_id, entry_id),
  CHECK ((kind = 'correction' AND correction_of IS NOT NULL) OR (kind <> 'correction' AND correction_of IS NULL)),
  FOREIGN KEY (owner_id, workspace_id, operation_id, correction_of)
    REFERENCES audit_entry (owner_id, workspace_id, operation_id, entry_id)
);
CREATE INDEX IF NOT EXISTS audit_entry_operation_sequence
  ON audit_entry (owner_id, workspace_id, operation_id, sequence);
