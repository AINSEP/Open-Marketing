import { PolicyRepoPortSuite, CanonicalIdentityPortSuite } from "./port-suites.js";
import { createSqlPolicyRepo, createSqlCanonicalIdentity } from "../../index.js";
import { sqliteFixture } from "../sql-fixture.js";

PolicyRepoPortSuite({ name: "SQLite", create: () => {
  const fixture = sqliteFixture();
  return { port: createSqlPolicyRepo({ pool: fixture.pool }), close: fixture.close };
} });
CanonicalIdentityPortSuite({ name: "SQLite", create: () => {
  const fixture = sqliteFixture();
  return { port: createSqlCanonicalIdentity({ pool: fixture.pool }), close: fixture.close };
} });
