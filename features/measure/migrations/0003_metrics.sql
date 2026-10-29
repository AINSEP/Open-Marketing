-- Local measure migration 3; server integrator registers global v25.
CREATE TABLE measure_metrics_batch (
  scope_key TEXT NOT NULL, sync_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL, connection_id TEXT NOT NULL, account_id TEXT NOT NULL,
  grain TEXT NOT NULL, retrieved_at INTEGER NOT NULL,
  request_json TEXT NOT NULL, batch_json TEXT NOT NULL,
  PRIMARY KEY (scope_key, sync_id)
);
CREATE INDEX measure_metrics_series ON measure_metrics_batch
  (scope_key, plugin_id, connection_id, account_id, grain, retrieved_at, sync_id);
CREATE TABLE measure_metrics_day (
  scope_key TEXT NOT NULL, sync_id TEXT NOT NULL, day TEXT NOT NULL,
  previous_sync_id TEXT,
  PRIMARY KEY (scope_key, sync_id, day),
  FOREIGN KEY (scope_key, sync_id) REFERENCES measure_metrics_batch(scope_key, sync_id)
);
CREATE INDEX measure_metrics_days ON measure_metrics_day (scope_key, day, sync_id);
