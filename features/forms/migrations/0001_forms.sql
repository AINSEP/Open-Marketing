-- Additive, unapplied. Jini CMS 0.5.6 repository columns; composition owns migration execution.
-- workspace_id is the global OM UUID passed directly to Jini, with no mapping table.
CREATE TABLE om_form_definitions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspace(workspace_id),
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    fields_json TEXT NOT NULL CHECK (json_valid(fields_json)),
    notify_json TEXT NOT NULL CHECK (json_valid(notify_json)),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (workspace_id, id),
    UNIQUE (workspace_id, slug)
);
CREATE TABLE om_form_submissions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    form_definition_id TEXT NOT NULL,
    data_json TEXT NOT NULL CHECK (json_valid(data_json) AND length(data_json) <= 65536),
    source_ip TEXT,
    submitted_at TEXT NOT NULL,
    deleted_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id, form_definition_id) REFERENCES om_form_definitions(workspace_id, id)
);
CREATE INDEX om_form_submissions_definition ON om_form_submissions(workspace_id, form_definition_id, submitted_at DESC, id DESC);

-- Publications are immutable snapshots. Answer PII remains in the erasable submission store.
CREATE TABLE om_form_publications (
    workspace_id TEXT NOT NULL,
    publication_id TEXT NOT NULL,
    form_definition_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    publication_json TEXT NOT NULL CHECK (json_valid(publication_json) AND length(publication_json) <= 65536),
    published_at BIGINT NOT NULL,
    PRIMARY KEY (workspace_id, publication_id),
    UNIQUE (workspace_id, slug, version),
    FOREIGN KEY (workspace_id, form_definition_id) REFERENCES om_form_definitions(workspace_id, id)
);
-- Retain only IDs and the body digest; no answers, address, click ID or IP in receipts/jobs.
CREATE TABLE om_form_submission_receipts (
    workspace_id TEXT NOT NULL,
    publication_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL CHECK (length(attempt_id) BETWEEN 1 AND 256),
    body_digest TEXT NOT NULL CHECK (length(body_digest) = 64),
    submission_id TEXT NOT NULL,
    job_id TEXT NOT NULL REFERENCES job(id),
    PRIMARY KEY (workspace_id, publication_id, attempt_id),
    FOREIGN KEY (workspace_id, publication_id) REFERENCES om_form_publications(workspace_id, publication_id),
    FOREIGN KEY (workspace_id, submission_id) REFERENCES om_form_submissions(workspace_id, id)
);
CREATE INDEX om_form_receipts_submission ON om_form_submission_receipts(workspace_id, submission_id);
