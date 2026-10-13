-- Additive; never applied by feature code. Historical rows without an account
-- remain unknown and are excluded from account-bound CAC. Do not infer a backfill.
ALTER TABLE measure_attribution_result ADD COLUMN account_id TEXT;
CREATE INDEX measure_attribution_account_period ON measure_attribution_result
  (scope_key, account_id, model_version, source_id, event_id);
CREATE INDEX measure_conversion_identity ON measure_conversion_event
  (scope_key, event_id);
