import { JobRepoPortSuite } from "./port-suites.js";
import { OutboxStoreSuite } from "./store-suite.js";
import { createSqlJobRepo, createSqlOutboxStore } from "../../index.js";
import { clockFixture, idsFixture, policy } from "../fixtures.js";
import { sqliteFixture } from "../sql-fixture.js";
JobRepoPortSuite({ name: "SQLite", create: () => {
    const fixture = sqliteFixture({});
    return { port: createSqlJobRepo({ database: fixture.database, clock: clockFixture({}), ids: idsFixture({}), retryPolicy: policy }), close: fixture.close };
} });
OutboxStoreSuite({ name: "SQLite", create: required => {
    const fixture = sqliteFixture({});
    return { store: createSqlOutboxStore({ ...required, database: fixture.database }), close: fixture.close };
} });
