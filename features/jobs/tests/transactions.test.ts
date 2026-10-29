import { DomainIntentSuite } from "./contract/intent-suite.js";
import { createDomainIntentTransaction, createMemoryTransactionalJobs, createSqlJobRepo, jobTenant } from "../index.js";
import type { Outcome } from "@open-marketing/contracts";
import { clockFixture, idsFixture, policy } from "./fixtures.js";
import { sqliteFixture } from "./sql-fixture.js";
import { canonicalJson } from "../src/schema.js";
DomainIntentSuite({ name: "memory", create: required => {
    const clock = clockFixture({});
    const unit = createMemoryTransactionalJobs({ clock, ids: idsFixture({}), retryPolicy: policy,
        acceptIntent() {
            required.abortWriter?.abort();
            if (required.throwWriter) throw new Error("Injected domain writer failure");
            if (required.reject) return { ok: false, error: { code: "conflict", message: "Intent rejected", retryable: false } };
            return { ok: true, value: undefined };
        },
    });
    return { port: unit.intents, repo: unit.repo, clock, async readIntent(input) { return unit.intent(input); }, close() {} };
} });
DomainIntentSuite({ name: "SQLite", create: required => {
    const fixture = sqliteFixture({});
    const clock = clockFixture({}); const ids = idsFixture({});
    fixture.native.exec("CREATE TABLE test_domain_intent (tenant_id TEXT, intent_id TEXT, job_id TEXT, operation_id TEXT, payload TEXT, PRIMARY KEY (tenant_id, intent_id))");
    const repo = createSqlJobRepo({ database: fixture.database, clock, ids, retryPolicy: policy });
    const port = createDomainIntentTransaction({ database: fixture.database, clock, ids, writer: {
        async write(input): Promise<Outcome<void>> {
            const tenantId = jobTenant(input);
            const payload = canonicalJson({ value: input.job });
            await input.session.query({ text: "INSERT INTO test_domain_intent (tenant_id, intent_id, job_id, operation_id, payload) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,intent_id) DO NOTHING", values: [tenantId, input.intentId, input.receipt.jobId, input.job.operationId, payload] });
            const saved = await input.session.query({ text: "SELECT payload FROM test_domain_intent WHERE tenant_id = $1 AND intent_id = $2", values: [tenantId, input.intentId] });
            required.abortWriter?.abort();
            if (required.throwWriter) throw new Error("Injected domain writer failure after write");
            if (required.reject || saved.rows[0]?.payload !== payload) return { ok: false, error: { code: "conflict", message: "Intent rejected", retryable: false } };
            return { ok: true, value: undefined };
        },
    } });
    return { repo, port, clock, close: fixture.close, async readIntent(input) {
        const row = fixture.native.prepare("SELECT job_id, operation_id FROM test_domain_intent WHERE tenant_id = ? AND intent_id = ?").get(jobTenant(input), input.intentId) as { job_id: string; operation_id: string } | undefined;
        if (!row) return null;
        return { jobId: row.job_id, operationId: row.operation_id };
    } };
} });
