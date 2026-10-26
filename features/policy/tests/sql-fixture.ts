import { readFileSync } from "node:fs";
import { createSqliteFixture } from "@open-marketing/om-db/testing";
import { subject } from "./fixtures.js";

/** Checked SQLite plus the policy-owned subject seed; borrowed sessions join the root. */
export function sqliteFixture() {
  const fixture = createSqliteFixture({ migrations: [readFileSync(new URL("../migrations/0001_policy.sql", import.meta.url), "utf8")] });
  fixture.native.prepare("INSERT INTO policy_subject_identifier VALUES (?, ?, ?, ?)").run(subject.scope.ownerId, subject.scope.workspaceId, "email:subject", subject.subjectId);
  return { pool: fixture.database, db: fixture.native, close: fixture.close };
}
