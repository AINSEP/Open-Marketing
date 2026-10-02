-- SQLite-only guards. A future Postgres composition needs equivalent privileges/trigger syntax.
-- No retention/deletion authority is created; privacy retention remains an owner decision.
CREATE TRIGGER IF NOT EXISTS audit_entry_no_update
BEFORE UPDATE ON audit_entry BEGIN
  SELECT RAISE(ABORT, 'audit entries are append-only');
END;
CREATE TRIGGER IF NOT EXISTS audit_entry_no_delete
BEFORE DELETE ON audit_entry BEGIN
  SELECT RAISE(ABORT, 'audit entries are append-only');
END;
