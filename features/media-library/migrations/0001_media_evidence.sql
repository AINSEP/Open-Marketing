-- OM marketing evidence only. Jini owns canonical media/blob/rendition tables.
-- Apply through the server migration runner; importing the feature never applies DDL.
CREATE TABLE IF NOT EXISTS om_media_evidence (
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('provenance','link','cost','crop')),
  record_key TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (owner_id, workspace_id, kind, record_key)
);
CREATE INDEX IF NOT EXISTS om_media_evidence_operation
  ON om_media_evidence (owner_id, workspace_id, operation_id);
