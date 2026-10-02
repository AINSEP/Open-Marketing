-- Additive, never applied by the feature. Jobs owns the ONLY outbox table.
CREATE TABLE IF NOT EXISTS measure_conversion_event (
  scope_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  authentication_revision BIGINT NOT NULL,
  occurred_at BIGINT NOT NULL,
  identity TEXT NOT NULL,
  event_json TEXT NOT NULL,
  context_json TEXT NOT NULL,
  job_id TEXT NOT NULL,
  PRIMARY KEY (scope_key, source_id, event_id)
);
CREATE INDEX IF NOT EXISTS measure_conversion_period ON measure_conversion_event (scope_key, occurred_at);
CREATE TABLE IF NOT EXISTS measure_platform_snapshot (
  scope_key TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  PRIMARY KEY (scope_key, snapshot_id)
);
CREATE TABLE IF NOT EXISTS measure_attribution_result (
  scope_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  result_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  campaign_id TEXT,
  result_json TEXT NOT NULL,
  PRIMARY KEY (scope_key, source_id, event_id, model_version),
  UNIQUE (scope_key, result_id),
  FOREIGN KEY (scope_key, source_id, event_id) REFERENCES measure_conversion_event (scope_key, source_id, event_id)
);
CREATE TABLE IF NOT EXISTS measure_conversion_delivery (
  scope_key TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  version BIGINT NOT NULL,
  record_json TEXT NOT NULL,
  context_json TEXT NOT NULL,
  PRIMARY KEY (scope_key, delivery_id, version)
);
CREATE TABLE IF NOT EXISTS measure_egress_audit (
  scope_key TEXT NOT NULL,
  audit_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  context_json TEXT NOT NULL,
  recorded_at BIGINT NOT NULL,
  PRIMARY KEY (scope_key, audit_id)
);
CREATE TABLE IF NOT EXISTS measure_tracked_link (
  scope_key TEXT NOT NULL,
  link_id TEXT NOT NULL,
  link_json TEXT NOT NULL,
  PRIMARY KEY (scope_key, link_id)
);
