-- Lifecycle state, not an evidence ledger. Applied only by the server migration owner.
CREATE TABLE privacy_request (
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  requested_at INTEGER NOT NULL CHECK (requested_at >= 0),
  version INTEGER NOT NULL CHECK (version >= 1),
  payload TEXT NOT NULL,
  PRIMARY KEY (owner_id, workspace_id, request_id)
);
CREATE INDEX privacy_request_subject ON privacy_request (owner_id, workspace_id, subject_id);
