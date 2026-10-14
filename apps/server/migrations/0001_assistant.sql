-- Frozen @jini-ai/chat 0.6.2 transcript DDL; OM is the sole migrator.

CREATE TABLE IF NOT EXISTS ai_chats (
  id            TEXT PRIMARY KEY,
  scope_id      TEXT NOT NULL,
  owner_kind    TEXT NOT NULL CHECK (owner_kind IN ('user','guest')),
  owner_id      TEXT NOT NULL,
  title         TEXT,
  title_source  TEXT NOT NULL DEFAULT 'fallback'
                CHECK (title_source IN ('fallback','generated','manual')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  expires_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_ai_chats_owner
  ON ai_chats(scope_id, owner_kind, owner_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_chats_expiry
  ON ai_chats(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS ai_chat_messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL,
  agent_id        TEXT,
  agent_name      TEXT,
  events_json     TEXT,
  attachments_json TEXT,
  run_id          TEXT,
  run_status      TEXT,
  position        INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  started_at      INTEGER,
  ended_at        INTEGER,
  UNIQUE (conversation_id, position)
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_order
  ON ai_chat_messages(conversation_id, position);

CREATE TABLE assistant_run_attempts (
 message_id TEXT PRIMARY KEY REFERENCES ai_chat_messages(id) ON DELETE CASCADE,
 engine TEXT NOT NULL, accepted_json TEXT NOT NULL, recovery_count INTEGER NOT NULL,
 recovery_deadline INTEGER, recovery_elapsed_ms INTEGER NOT NULL,
 attempt_started_at INTEGER NOT NULL, last_progress_at INTEGER NOT NULL,
 cancel_reason TEXT, session_id TEXT, session_confirmed INTEGER NOT NULL,
 child_pid INTEGER, child_started_at TEXT, attempt_base_json TEXT NOT NULL
);
CREATE TABLE assistant_agent_sessions (
 conversation_id TEXT NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE,
 agent_id TEXT NOT NULL, session_id TEXT NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY (conversation_id, agent_id)
);
CREATE TABLE om_assistant_settings (
 owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, settings_json TEXT NOT NULL,
 PRIMARY KEY (owner_id, workspace_id)
);
CREATE TABLE om_assistant_runs (
 run_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL REFERENCES ai_chats(id), message_id TEXT NOT NULL REFERENCES ai_chat_messages(id),
 context_json TEXT NOT NULL, settings_json TEXT NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('running','completed','cancelled','interrupted')),
 expires_at INTEGER NOT NULL, retained_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE om_assistant_events (
 run_id TEXT NOT NULL REFERENCES om_assistant_runs(run_id), sequence INTEGER NOT NULL,
 event_id TEXT NOT NULL, event_json TEXT NOT NULL,
 PRIMARY KEY (run_id, sequence), UNIQUE (run_id, event_id)
);
