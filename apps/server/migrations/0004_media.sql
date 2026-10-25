-- Host persistence for Jini's canonical media repository ports. Marketing evidence remains
-- in om_media_evidence (global migration 8); binary content stays in the scoped blob store.
CREATE TABLE server_media_record (
    owner_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('media','blob','rendition','transform')),
    record_key TEXT NOT NULL,
    payload TEXT NOT NULL CHECK (json_valid(payload) AND length(CAST(payload AS BLOB)) <= 100000),
    PRIMARY KEY (owner_id, workspace_id, kind, record_key),
    CHECK (json_extract(payload, '$.workspaceId') = workspace_id)
);
CREATE UNIQUE INDEX server_media_slug ON server_media_record
    (owner_id, workspace_id, json_extract(payload, '$.slug')) WHERE kind='media';
CREATE INDEX server_media_asset ON server_media_record
    (owner_id, workspace_id, kind, json_extract(payload, '$.assetId'));
CREATE INDEX server_media_transform ON server_media_record
    (owner_id, workspace_id, kind, json_extract(payload, '$.name'));
CREATE TRIGGER server_media_transform_no_update BEFORE UPDATE ON server_media_record
    WHEN OLD.kind='transform' BEGIN SELECT RAISE(ABORT, 'Transform definitions are append-only'); END;
CREATE TRIGGER server_media_transform_no_delete BEFORE DELETE ON server_media_record
    WHEN OLD.kind='transform' BEGIN SELECT RAISE(ABORT, 'Transform definitions are append-only'); END;
