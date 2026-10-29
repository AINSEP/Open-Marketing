import { readFileSync } from "node:fs";
import { createSqliteFixture } from "@open-marketing/om-db/testing";

/** Checked SQLite evidence storage; borrowed sessions join the root. */
export function sqliteFixture() {
  const fixture = createSqliteFixture({ migrations: [readFileSync(new URL("../migrations/0001_policy.sql", import.meta.url), "utf8")] });
  return { pool: fixture.database, db: fixture.native, close: fixture.close };
}
