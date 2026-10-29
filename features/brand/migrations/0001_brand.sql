-- Global migration v26. Applied only by the server's migration owner.
CREATE TABLE brand_revision (
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  record_json TEXT NOT NULL,
  PRIMARY KEY (owner_id, workspace_id, revision)
);
CREATE TABLE brand_current (
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  latest_revision INTEGER NOT NULL,
  confirmed_revision INTEGER,
  PRIMARY KEY (owner_id, workspace_id),
  FOREIGN KEY (owner_id, workspace_id, latest_revision) REFERENCES brand_revision (owner_id, workspace_id, revision),
  FOREIGN KEY (owner_id, workspace_id, confirmed_revision) REFERENCES brand_revision (owner_id, workspace_id, revision),
  CHECK (confirmed_revision IS NULL OR confirmed_revision <= latest_revision)
);
CREATE TRIGGER brand_revision_no_update BEFORE UPDATE ON brand_revision
BEGIN SELECT RAISE(ABORT, 'Brand revisions are immutable'); END;
CREATE TRIGGER brand_revision_no_delete BEFORE DELETE ON brand_revision
BEGIN SELECT RAISE(ABORT, 'Brand revisions are immutable'); END;
