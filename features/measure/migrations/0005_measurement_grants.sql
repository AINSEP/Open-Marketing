-- Local measure migration 5; server integrator registers the next global version.
CREATE TABLE measure_grant (
  scope_key TEXT NOT NULL, grant_id TEXT NOT NULL,
  grant_json TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER,
  PRIMARY KEY (scope_key, grant_id)
);
