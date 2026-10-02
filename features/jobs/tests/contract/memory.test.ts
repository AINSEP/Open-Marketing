import { JobRepoPortSuite, JobDispatchPortSuite, JobAuthorizationPortSuite, JobObserverPortSuite } from "./port-suites.js";
import { OutboxStoreSuite } from "./store-suite.js";
import { createMemoryJobRepo, createMemoryJobDispatch, createMemoryJobAuthorization, createMemoryJobObserver, createMemoryOutboxStore } from "../../index.js";
import { clockFixture, idsFixture, policy, job } from "../fixtures.js";
import type { ProcessResult } from "../../index.js";
JobRepoPortSuite({ name: "memory", create: () => ({ port: createMemoryJobRepo({ clock: clockFixture({}), ids: idsFixture({}), retryPolicy: policy }), close() {} }) });
OutboxStoreSuite({ name: "memory", create: required => ({ store: createMemoryOutboxStore(required), close() {} }) });
JobDispatchPortSuite({ name: "memory", create: required => {
    if (!required.result) return createMemoryJobDispatch({});
    const state = required.result.kind === "success" ? "succeeded" : { transient: "retry", permanent: "failed", unknown: "reconcile" }[required.result.classification];
    return createMemoryJobDispatch({ result: { ok: true, value: { kind: "completed", jobId: job.operationId, state } as ProcessResult } });
} });
JobAuthorizationPortSuite({ create: createMemoryJobAuthorization });
JobObserverPortSuite({ create: () => createMemoryJobObserver({}) });
