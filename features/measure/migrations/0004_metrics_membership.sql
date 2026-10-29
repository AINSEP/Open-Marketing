CREATE INDEX IF NOT EXISTS measure_metrics_membership ON measure_metrics_batch (scope_key, plugin_id, account_id, grain, retrieved_at, sync_id);
