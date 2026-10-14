-- Global version 18. No execution here; the server's single migration runner owns application.
CREATE TABLE addon_package (
    owner_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('plugin','agent-plugin','skill')),
    addon_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    PRIMARY KEY (owner_id,workspace_id,kind,addon_id)
);
-- Canonical Jini activation row shape, scoped by the host's per-workspace install directory.
CREATE TABLE addon_plugin_activation (
    workspace_id TEXT NOT NULL,
    plugin_id TEXT NOT NULL,
    version TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
    updated_at TEXT NOT NULL,
    quarantined_at TEXT,
    quarantine_reason TEXT,
    quarantine_failure_count INTEGER,
    PRIMARY KEY (workspace_id,plugin_id)
);
CREATE TABLE addon_external_mcp (
    owner_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    plugin_id TEXT,
    revision TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
    configuration TEXT NOT NULL,
    PRIMARY KEY (owner_id,workspace_id,connection_id)
);
