import { readFileSync } from "node:fs";
import { createSqliteFixture } from "@open-marketing/om-db/testing";

/** Disposable checked SQLite; the shared fixture owns binding, serialization and cleanup. */
export function sqliteFixture(required: { path?: string }) {
    return createSqliteFixture({ migrations: [readFileSync(new URL("../migrations/0001_jobs.sql", import.meta.url), "utf8")] }, { filename: required.path });
}
