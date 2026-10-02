-- Additive creative-owned schema. Never applied by an import or factory.
CREATE TABLE IF NOT EXISTS creative_generation_request (
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  status_json TEXT NOT NULL,
  PRIMARY KEY (owner_id, workspace_id, generation_id)
);
CREATE TABLE IF NOT EXISTS creative_generation_cost_observation (
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  cost_json TEXT NOT NULL,
  PRIMARY KEY (owner_id, workspace_id, observation_id),
  FOREIGN KEY (owner_id, workspace_id, generation_id)
    REFERENCES creative_generation_request (owner_id, workspace_id, generation_id)
);
CREATE INDEX IF NOT EXISTS creative_generation_cost_generation
  ON creative_generation_cost_observation (owner_id, workspace_id, generation_id);
