-- Additive, never auto-applied. Feature-owned SQLite/Postgres-portable safety snapshot and immutable journal.
-- Server db adapter supplies transaction isolation. A failed CAS must roll back the complete transaction.
CREATE TABLE IF NOT EXISTS safety_state (
 scope_key TEXT PRIMARY KEY,
 version BIGINT NOT NULL CHECK (version >= 0),
 payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS safety_journal (
 scope_key TEXT NOT NULL,
 sequence BIGINT NOT NULL CHECK (sequence > 0),
 kind TEXT NOT NULL,
 operation_id TEXT NOT NULL,
 payload TEXT NOT NULL,
 PRIMARY KEY (scope_key, sequence),
 FOREIGN KEY (scope_key) REFERENCES safety_state(scope_key)
);
CREATE INDEX IF NOT EXISTS safety_journal_operation ON safety_journal(scope_key, operation_id);
