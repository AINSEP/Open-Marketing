-- Contacts-owned mutable PII and retained HMAC tombstones. Integration applies this migration.
CREATE TABLE contact_subject (
  creation_order INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  merged_into TEXT,
  timezone TEXT,
  erased INTEGER NOT NULL DEFAULT 0 CHECK (erased IN (0, 1)),
  UNIQUE (owner_id, workspace_id, subject_id),
  FOREIGN KEY (owner_id, workspace_id, merged_into)
    REFERENCES contact_subject (owner_id, workspace_id, subject_id)
);
CREATE INDEX contact_subject_pointer ON contact_subject (owner_id, workspace_id, merged_into);
CREATE TABLE contact_identifier (
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  identifier_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('email','phone','external_customer_id','fbclid','fbc','fbp','gclid','gbraid','wbraid')),
  normalized_value TEXT,
  normalization_version TEXT NOT NULL,
  identifier_digest TEXT NOT NULL,
  key_version TEXT NOT NULL,
  PRIMARY KEY (owner_id, workspace_id, identifier_id),
  FOREIGN KEY (owner_id, workspace_id, subject_id)
    REFERENCES contact_subject (owner_id, workspace_id, subject_id)
);
CREATE UNIQUE INDEX contact_stable_digest ON contact_identifier (owner_id, workspace_id, kind, identifier_digest)
  WHERE kind IN ('email','phone','external_customer_id');
CREATE UNIQUE INDEX contact_stable_value ON contact_identifier (owner_id, workspace_id, kind, normalized_value, key_version)
  WHERE kind IN ('email','phone','external_customer_id') AND normalized_value IS NOT NULL;
CREATE INDEX contact_identifier_digest ON contact_identifier (owner_id, workspace_id, kind, identifier_digest);
CREATE INDEX contact_identifier_subject ON contact_identifier (owner_id, workspace_id, subject_id);
CREATE TABLE contact_merge (
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  source_subject_id TEXT NOT NULL,
  target_subject_id TEXT NOT NULL,
  merged_at INTEGER NOT NULL CHECK (merged_at >= 0),
  PRIMARY KEY (owner_id, workspace_id, source_subject_id),
  FOREIGN KEY (owner_id, workspace_id, source_subject_id)
    REFERENCES contact_subject (owner_id, workspace_id, subject_id),
  FOREIGN KEY (owner_id, workspace_id, target_subject_id)
    REFERENCES contact_subject (owner_id, workspace_id, subject_id)
);
CREATE TRIGGER contact_merge_no_update BEFORE UPDATE ON contact_merge BEGIN
  SELECT RAISE(ABORT, 'Contact merge lineage is append-only');
END;
CREATE TRIGGER contact_merge_no_delete BEFORE DELETE ON contact_merge BEGIN
  SELECT RAISE(ABORT, 'Contact merge lineage is append-only');
END;
