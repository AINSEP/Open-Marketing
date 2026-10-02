import { AuditRepoPortSuite, AuditSqlPortSuite } from "./port-suites.js";
import { createSqlAuditRepo, createMemoryAuditObserver } from "../../index.js";
import { dependencies } from "../fixtures.js";
import { sqliteHarness } from "../sqlite-fixture.js";

AuditRepoPortSuite({ name: "SQL (real disposable SQLite)", create() {
  const fixture = sqliteHarness();
  const repo = createSqlAuditRepo({ ...dependencies(), db: fixture.db, observer: createMemoryAuditObserver({}) });
  return { repo, dispose() { fixture.native.close(); } };
} });
AuditSqlPortSuite({ name: "SQLite composition bridge", create() {
  const fixture = sqliteHarness();
  return { ...fixture, dispose() { fixture.native.close(); } };
} });
