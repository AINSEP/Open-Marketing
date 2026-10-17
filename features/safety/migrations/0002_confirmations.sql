CREATE TABLE safety_confirmations (
 owner_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 card_id TEXT NOT NULL,
 status TEXT NOT NULL,
 expires_at BIGINT NOT NULL,
 payload TEXT NOT NULL,
 PRIMARY KEY (owner_id, workspace_id, card_id)
);
CREATE INDEX safety_confirmations_scope_status ON safety_confirmations (owner_id, workspace_id, status, card_id);
