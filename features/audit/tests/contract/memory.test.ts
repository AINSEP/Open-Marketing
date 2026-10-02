import { AuditRepoPortSuite, AuditRedactorPortSuite, AuditObserverPortSuite, AuditSqlPortSuite } from "./port-suites.js";
import { createMemoryAuditRepo, createMemoryAuditRedactor, createMemoryAuditObserver, createJiniAuditRedactor } from "../../index.js";
import { dependencies } from "../fixtures.js";
import { memorySqlHarness } from "../sqlite-fixture.js";

AuditRepoPortSuite({ name: "memory", create() { return { repo: createMemoryAuditRepo(dependencies()), dispose() {} }; } });
AuditRedactorPortSuite({ name: "conservative memory", create() { return createMemoryAuditRedactor({}); } });
// Scripted scrubber is the in-memory double of the composition wrapper, not a copy of Jini's lexical algorithm.
AuditRedactorPortSuite({ name: "Jini adapter with scrubber double", create() {
  const replacements = new Map([
    ["person@example.com", "[REDACTED:email]"],
    ["sk-abcdefghijklmnopqrstuvwxyz0123456789", "[REDACTED:sk_key]"],
  ]);
  return createJiniAuditRedactor({ scrubber: { redact({ text }) { return replacements.get(text) ?? text; } } });
} });
AuditObserverPortSuite({ name: "memory", create() {
  const observer = createMemoryAuditObserver({});
  return { observer, events: observer.events };
} });
AuditObserverPortSuite({ name: "forwarding composition adapter", create() {
  const sink = createMemoryAuditObserver({});
  return { observer: { observe(event) { sink.observe(event); } }, events: sink.events };
} });
AuditSqlPortSuite({ name: "scripted memory double", create() {
  const harness = memorySqlHarness({ respond({ values }) { return { rows: [{ value: values[0] }] }; } });
  return { ...harness, dispose() {} };
} });
