-- Registered global v24; never applied by module import.
CREATE TABLE om_owner_settings (
    owner_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value_json TEXT NOT NULL CHECK (json_valid(value_json) AND length(CAST(value_json AS BLOB)) <= 4096),
    PRIMARY KEY (owner_id, workspace_id, key)
);
CREATE TABLE server_alert_notice (
    owner_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    notice_id TEXT NOT NULL,
    dedup_key TEXT NOT NULL,
    created_at BIGINT NOT NULL CHECK (created_at >= 0),
    candidate TEXT NOT NULL CHECK (json_valid(candidate) AND length(CAST(candidate AS BLOB)) <= 32768),
    PRIMARY KEY (owner_id, workspace_id, notice_id),
    UNIQUE (owner_id, workspace_id, dedup_key)
);
CREATE TABLE server_alert_ack (
    owner_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    notice_id TEXT NOT NULL,
    acknowledged_at BIGINT NOT NULL CHECK (acknowledged_at >= 0),
    approver TEXT NOT NULL CHECK (json_valid(approver) AND length(CAST(approver AS BLOB)) <= 2048),
    PRIMARY KEY (owner_id, workspace_id, notice_id),
    FOREIGN KEY (owner_id, workspace_id, notice_id) REFERENCES server_alert_notice(owner_id, workspace_id, notice_id)
);
CREATE INDEX server_alert_notice_feed ON server_alert_notice (owner_id, workspace_id, created_at, notice_id);
-- Reservations survive delivery failure/uncertainty. A slot is consumed once, never refunded.
CREATE TABLE server_alert_email_reservation (
    owner_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    notice_id TEXT NOT NULL,
    local_day BIGINT NOT NULL CHECK (local_day >= 0),
    daily_slot INTEGER NOT NULL CHECK (daily_slot BETWEEN 1 AND 20),
    reserved_at BIGINT NOT NULL CHECK (reserved_at >= 0),
    PRIMARY KEY (owner_id, workspace_id, notice_id),
    UNIQUE (owner_id, local_day, daily_slot),
    FOREIGN KEY (owner_id, workspace_id, notice_id) REFERENCES server_alert_notice(owner_id, workspace_id, notice_id)
);
CREATE TRIGGER server_alert_notice_no_update BEFORE UPDATE ON server_alert_notice
    BEGIN SELECT RAISE(ABORT, 'Alert notices are append-only'); END;
CREATE TRIGGER server_alert_notice_no_delete BEFORE DELETE ON server_alert_notice
    BEGIN SELECT RAISE(ABORT, 'Alert notices are append-only'); END;
CREATE TRIGGER server_alert_ack_no_update BEFORE UPDATE ON server_alert_ack
    BEGIN SELECT RAISE(ABORT, 'Alert acknowledgements are append-only'); END;
CREATE TRIGGER server_alert_ack_no_delete BEFORE DELETE ON server_alert_ack
    BEGIN SELECT RAISE(ABORT, 'Alert acknowledgements are append-only'); END;
CREATE TRIGGER server_alert_email_no_update BEFORE UPDATE ON server_alert_email_reservation
    BEGIN SELECT RAISE(ABORT, 'Alert email reservations are append-only'); END;
CREATE TRIGGER server_alert_email_no_delete BEFORE DELETE ON server_alert_email_reservation
    BEGIN SELECT RAISE(ABORT, 'Alert email reservations are append-only'); END;
