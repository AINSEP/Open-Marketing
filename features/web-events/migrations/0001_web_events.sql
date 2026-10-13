-- Feature-owned additive migration; application belongs to the server integrator.
CREATE TABLE web_event_cursor (
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  cursor INTEGER NOT NULL CHECK (cursor >= 1),
  PRIMARY KEY (owner_id, workspace_id)
);
CREATE TABLE web_event (
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  subject_id TEXT,
  anonymous_id TEXT,
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
  cursor INTEGER NOT NULL CHECK (cursor >= 1),
  semantic_digest TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (owner_id, workspace_id, event_id),
  UNIQUE (owner_id, workspace_id, cursor),
  CHECK (subject_id IS NOT NULL OR anonymous_id IS NOT NULL)
);
CREATE TABLE web_touch (
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  touch_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  link_id TEXT,
  campaign_id TEXT,
  click_identifiers TEXT NOT NULL,
  PRIMARY KEY (owner_id, workspace_id, touch_id),
  UNIQUE (owner_id, workspace_id, event_id),
  FOREIGN KEY (owner_id, workspace_id, event_id) REFERENCES web_event(owner_id, workspace_id, event_id)
);
CREATE TABLE web_visit (
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  visit_id TEXT NOT NULL,
  anonymous_id TEXT NOT NULL,
  subject_id TEXT,
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  PRIMARY KEY (owner_id, workspace_id, visit_id),
  UNIQUE (owner_id, workspace_id, anonymous_id)
);
CREATE INDEX web_event_subject_time ON web_event(owner_id, workspace_id, subject_id, occurred_at, event_id);
CREATE INDEX web_event_anonymous_time ON web_event(owner_id, workspace_id, anonymous_id, occurred_at, event_id);
CREATE INDEX web_visit_subject ON web_visit(owner_id, workspace_id, subject_id, anonymous_id);
