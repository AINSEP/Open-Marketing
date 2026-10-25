-- Globally allocated v22. Server-owned append-only request intents and completion receipts.
CREATE TABLE om_model_usage (
 request_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('intent','completion')),
 run_id TEXT NOT NULL REFERENCES om_assistant_runs(run_id), owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
 recorded_at BIGINT NOT NULL, input_tokens BIGINT, output_tokens BIGINT, cost_usd DOUBLE PRECISION,
 evidence_json TEXT NOT NULL, PRIMARY KEY (request_id,kind)
);
CREATE INDEX om_model_usage_run ON om_model_usage(owner_id,workspace_id,run_id);
