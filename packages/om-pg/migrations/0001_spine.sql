-- Product data only. Run through runMigrations on a dedicated product database.
-- Authorization is enforced by the embedding server; scoped FKs prevent accidental
-- cross-workspace references but are not a replacement for tenant authorization/RLS.
CREATE SCHEMA IF NOT EXISTS om;

CREATE TABLE om.tenant (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE om.workspace (
  tenant_id uuid NOT NULL REFERENCES om.tenant(id),
  id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE om.subject (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  erased_at timestamptz,
  PRIMARY KEY (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES om.workspace(tenant_id, id),
  CHECK (erased_at IS NULL OR erased_at >= created_at)
);

CREATE TABLE om.subject_identifier (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  subject_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('fbclid', 'gclid', 'ttclid', 'li_fat_id',
    'anonymous_id', 'email', 'phone', 'sha256_email', 'order_id')),
  normalized_value text NOT NULL CHECK (length(normalized_value) BETWEEN 1 AND 2048),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, kind, normalized_value),
  FOREIGN KEY (tenant_id, workspace_id, subject_id) REFERENCES om.subject(tenant_id, workspace_id, id)
);
CREATE INDEX subject_identifier_subject ON om.subject_identifier (tenant_id, workspace_id, subject_id);

-- Merge-cycle detection, survivor selection and identifier transfer are a single
-- application transaction. This table records the result, not a second merge engine.
CREATE TABLE om.subject_merge (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  source_subject_id uuid NOT NULL,
  target_subject_id uuid NOT NULL,
  merged_at timestamptz NOT NULL,
  principal text NOT NULL CHECK (principal ~ '^(human|agent:.+|mcp:.+)$'),
  PRIMARY KEY (tenant_id, workspace_id, source_subject_id),
  FOREIGN KEY (tenant_id, workspace_id, source_subject_id) REFERENCES om.subject(tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, target_subject_id) REFERENCES om.subject(tenant_id, workspace_id, id),
  CHECK (source_subject_id <> target_subject_id)
);

-- Assignment persists from first identity creation; no retroactive random reassignment.
CREATE TABLE om.holdout_assignment (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  is_holdout boolean NOT NULL,
  assignment_version integer NOT NULL CHECK (assignment_version > 0),
  assigned_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, subject_id),
  FOREIGN KEY (tenant_id, workspace_id, subject_id) REFERENCES om.subject(tenant_id, workspace_id, id)
);

-- Consent records are append-oriented evidence. A gate resolves latest applicable
-- evidence; suppression and consent withdrawal remain distinct facts.
CREATE TABLE om.consent (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  subject_id uuid NOT NULL,
  purpose text NOT NULL CHECK (length(btrim(purpose)) > 0),
  scope text NOT NULL CHECK (scope IN ('channel', 'destination')),
  target text NOT NULL CHECK (length(btrim(target)) > 0),
  state text NOT NULL CHECK (state IN ('granted', 'withdrawn')),
  occurred_at timestamptz NOT NULL,
  expires_at timestamptz,
  evidence_reference text NOT NULL CHECK (length(btrim(evidence_reference)) > 0),
  principal text NOT NULL CHECK (principal ~ '^(human|agent:.+|mcp:.+)$'),
  PRIMARY KEY (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, subject_id) REFERENCES om.subject(tenant_id, workspace_id, id),
  CHECK (expires_at IS NULL OR expires_at > occurred_at)
);
CREATE INDEX consent_subject_purpose ON om.consent
  (tenant_id, workspace_id, subject_id, purpose, scope, target, occurred_at DESC, id);

CREATE TABLE om.suppression (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  subject_id uuid NOT NULL,
  channel text NOT NULL CHECK (length(btrim(channel)) > 0),
  purpose text NOT NULL CHECK (length(btrim(purpose)) > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  principal text NOT NULL CHECK (principal ~ '^(human|agent:.+|mcp:.+)$'),
  PRIMARY KEY (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, subject_id) REFERENCES om.subject(tenant_id, workspace_id, id),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX suppression_subject ON om.suppression (tenant_id, workspace_id, subject_id, channel, purpose);

-- Credentials belong to a separate encrypted vault, never this row.
CREATE TABLE om.ad_account (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  platform text NOT NULL CHECK (platform IN ('meta', 'google', 'tiktok', 'linkedin')),
  external_account_id text NOT NULL CHECK (length(btrim(external_account_id)) > 0),
  mode text NOT NULL CHECK (mode IN ('sandbox', 'production', 'read_only')),
  halted_at timestamptz,
  PRIMARY KEY (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, platform, external_account_id),
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES om.workspace(tenant_id, id)
);

CREATE TABLE om.budget_authorization (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  ad_account_id uuid NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  authorized_at timestamptz NOT NULL,
  revoked_at timestamptz,
  creative_set_digest text NOT NULL CHECK (creative_set_digest ~ '^[a-f0-9]{64}$'),
  principal text NOT NULL CHECK (principal ~ '^(human|agent:.+|mcp:.+)$'),
  PRIMARY KEY (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, ad_account_id) REFERENCES om.ad_account(tenant_id, workspace_id, id),
  CHECK (ends_at > starts_at),
  CHECK (revoked_at IS NULL OR revoked_at >= authorized_at)
);
CREATE INDEX budget_authorization_account ON om.budget_authorization
  (tenant_id, workspace_id, ad_account_id, starts_at, ends_at);

-- Reserve commerce attribution fields before the full conversion-feed module.
CREATE TABLE om.conversion_event (
  tenant_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  id uuid NOT NULL,
  subject_id uuid NOT NULL,
  event_name text NOT NULL CHECK (length(btrim(event_name)) > 0),
  occurred_at timestamptz NOT NULL,
  value_minor bigint,
  currency text,
  PRIMARY KEY (tenant_id, workspace_id, id),
  FOREIGN KEY (tenant_id, workspace_id, subject_id) REFERENCES om.subject(tenant_id, workspace_id, id),
  CHECK ((value_minor IS NULL AND currency IS NULL) OR
    (value_minor IS NOT NULL AND currency IS NOT NULL AND currency ~ '^[A-Z]{3}$'))
);
