import { readFileSync } from "node:fs";
import { createSqliteFixture } from "@open-marketing/om-db/testing";

/** Test-owned checked query adapter; no native handle is constructed by credential code. */
export function createSqlFixture(required: Record<string, never>) {
  const fixture = createSqliteFixture({ migrations: [readFileSync(new URL("../migrations/0001_credentials.sql", import.meta.url), "utf8")] });
  return { db: fixture.database, database: fixture.native, dispose: fixture.close };
}
