import { JobServiceSuite } from "./contract/service-suite.js";
import { createMemoryJobRepo, createSqlJobRepo } from "../index.js";
import { policy } from "./fixtures.js";
import { sqliteFixture } from "./sql-fixture.js";
JobServiceSuite({ name: "memory", create: required => ({ repo: createMemoryJobRepo({ ...required, retryPolicy: policy }), close() {} }) });
JobServiceSuite({ name: "SQLite", create: required => {
    const fixture = sqliteFixture({});
    return { repo: createSqlJobRepo({ ...required, database: fixture.database, retryPolicy: policy }), close: fixture.close };
} });
