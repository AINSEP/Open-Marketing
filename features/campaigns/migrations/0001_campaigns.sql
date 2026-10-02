-- Additive, feature-owned tables. Never applied by import/factory.
-- JSON is stored as portable TEXT; no driver/vendor types or jobs outbox duplication.
CREATE TABLE IF NOT EXISTS campaign (
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  record_json TEXT NOT NULL,
  PRIMARY KEY (owner_id, workspace_id, campaign_id),
  UNIQUE (owner_id, workspace_id, operation_id)
);
CREATE TABLE IF NOT EXISTS campaign_revision (
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  revision BIGINT NOT NULL,
  observed_at BIGINT NOT NULL,
  observation_json TEXT NOT NULL,
  PRIMARY KEY (owner_id, workspace_id, campaign_id, revision),
  FOREIGN KEY (owner_id, workspace_id, campaign_id)
    REFERENCES campaign (owner_id, workspace_id, campaign_id)
);
CREATE TABLE IF NOT EXISTS campaign_launch_proposal (
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  PRIMARY KEY (owner_id, workspace_id, operation_id),
  FOREIGN KEY (owner_id, workspace_id, campaign_id)
    REFERENCES campaign (owner_id, workspace_id, campaign_id)
);
