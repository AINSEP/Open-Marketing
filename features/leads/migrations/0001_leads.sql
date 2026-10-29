-- leads-1: assigned global migration v23; application is Coordinator-owned.
CREATE TABLE lead (
  owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, lead_id TEXT NOT NULL,
  subject_id TEXT, source_kind TEXT NOT NULL CHECK(source_kind IN ('form','call','booking','manual')),
  source_ref TEXT NOT NULL, occurred_at BIGINT NOT NULL CHECK(occurred_at >= 0),
  created_at BIGINT NOT NULL CHECK(created_at >= 0), attribution TEXT NOT NULL CHECK(length(attribution)<=8192),
  stage TEXT NOT NULL CHECK(stage IN ('new','qualified','won','disqualified','spam')),
  revision BIGINT NOT NULL CHECK(revision >= 1), last_event_id TEXT NOT NULL,
  erased INTEGER NOT NULL DEFAULT 0 CHECK(erased IN (0,1)),
  PRIMARY KEY(owner_id,workspace_id,lead_id),
  UNIQUE(owner_id,workspace_id,source_kind,source_ref),
  CHECK((erased=0 AND subject_id IS NOT NULL) OR (erased=1 AND subject_id IS NULL))
);
CREATE INDEX lead_inbox ON lead(owner_id,workspace_id,stage,lead_id);
CREATE INDEX lead_subject ON lead(owner_id,workspace_id,subject_id);
CREATE TABLE lead_stage_event (
  owner_id TEXT NOT NULL, workspace_id TEXT NOT NULL, event_id TEXT NOT NULL,
  lead_id TEXT NOT NULL, revision BIGINT NOT NULL CHECK(revision >= 1), payload TEXT NOT NULL CHECK(length(payload)<=8192),
  PRIMARY KEY(owner_id,workspace_id,event_id),
  UNIQUE(owner_id,workspace_id,lead_id,revision),
  FOREIGN KEY(owner_id,workspace_id,lead_id) REFERENCES lead(owner_id,workspace_id,lead_id)
);
CREATE TRIGGER lead_stage_event_no_update BEFORE UPDATE ON lead_stage_event
BEGIN SELECT RAISE(ABORT, 'lead stage ledger is immutable'); END;
CREATE TRIGGER lead_stage_event_no_delete BEFORE DELETE ON lead_stage_event
BEGIN SELECT RAISE(ABORT, 'lead stage ledger is immutable'); END;
