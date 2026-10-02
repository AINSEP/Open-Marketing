-- Additive and unapplied. Server-owned SQLite; portable SQL for a later Postgres adapter.
CREATE TABLE IF NOT EXISTS job (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_digest TEXT NOT NULL,
    operation TEXT NOT NULL,
    payload TEXT NOT NULL CHECK (length(payload) <= 262144),
    context_json TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending','leased','dispatching','retry','succeeded','denied','failed','reconcile','cancelled')),
    attempts INTEGER NOT NULL CHECK (attempts >= 0 AND attempts <= 1000),
    available_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    lease_token TEXT,
    lease_expires_at BIGINT,
    UNIQUE (tenant_id, idempotency_key),
    UNIQUE (lease_token),
    CHECK ((state IN ('leased','dispatching') AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (state NOT IN ('leased','dispatching') AND lease_token IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX IF NOT EXISTS job_due ON job (state, available_at, created_at, id);
CREATE INDEX IF NOT EXISTS job_expired ON job (state, lease_expires_at, id);
-- Append-only attempt/transition evidence. Resolution never replaces earlier uncertainty.
CREATE TABLE IF NOT EXISTS job_attempt (
    job_id TEXT NOT NULL REFERENCES job(id),
    sequence INTEGER NOT NULL,
    tenant_id TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    state TEXT NOT NULL,
    observed_at BIGINT NOT NULL,
    evidence_id TEXT,
    PRIMARY KEY (job_id, sequence)
);
