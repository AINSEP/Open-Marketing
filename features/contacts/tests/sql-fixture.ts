import { readFileSync } from "node:fs";
import { createSqliteFixture } from "@open-marketing/om-db/testing";

/** Isolated checked SQLite; the caller owns disposal after all transaction work completes. */
export function createSqlFixture(_required: Record<string, never>) {
  const fixture = createSqliteFixture({ migrations: [readFileSync(new URL("../migrations/0001_contacts.sql", import.meta.url), "utf8")] });
  return { uow: fixture.database, db: fixture.native, close: fixture.close };
}
