-- Additive feature-owned schema. Apply only through the server migration runner.
-- Epoch milliseconds and TEXT JSON keep these tables portable to PostgreSQL.
CREATE TABLE IF NOT EXISTS policy_subject_identifier (
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  identifier TEXT NOT NULL CHECK (length(identifier) BETWEEN 1 AND 256),
  subject_id TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 256),
  PRIMARY KEY (owner_id, workspace_id, identifier)
);

-- Append only: no update/delete API. Merge, consent and suppression are distinct
-- typed records in payload. The owning adapter validates payload and scope.
CREATE TABLE IF NOT EXISTS policy_evidence (
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 256),
  subject_id TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 256),
  kind TEXT NOT NULL CHECK (kind IN ('consent', 'withdrawal', 'suppression', 'merge')),
  recorded_at BIGINT NOT NULL CHECK (recorded_at >= 0 AND recorded_at <= 9007199254740991),
  source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 256),
  payload TEXT NOT NULL CHECK (length(payload) <= 8192),
  PRIMARY KEY (owner_id, workspace_id, id)
);
CREATE INDEX IF NOT EXISTS policy_evidence_subject ON policy_evidence (owner_id, workspace_id, subject_id, id);
