import { PolicyRepoPortSuite } from "./port-suites.js";
import { createSqlPolicyRepo } from "../../index.js";
import { sqliteFixture } from "../sql-fixture.js";

PolicyRepoPortSuite({ name: "SQLite", create: () => {
  const fixture = sqliteFixture();
  return { port: createSqlPolicyRepo({ pool: fixture.pool }), close: fixture.close };
} });
