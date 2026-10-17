CREATE TABLE server_tool_operations (
 owner_id TEXT NOT NULL,
 workspace_id TEXT NOT NULL,
 operation_id TEXT NOT NULL,
 status TEXT NOT NULL,
 card_id TEXT,
 retention_order BIGINT NOT NULL,
 payload TEXT NOT NULL,
 PRIMARY KEY (owner_id, workspace_id, operation_id)
);
CREATE INDEX server_tool_operations_scope_status ON server_tool_operations (owner_id, workspace_id, status, card_id);
CREATE INDEX server_tool_operations_retention ON server_tool_operations (owner_id, workspace_id, retention_order);
