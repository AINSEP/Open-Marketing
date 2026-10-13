# audit

Public entry: `@open-marketing/audit` only.

Audit records intent, approval, dispatch, outcome and correction evidence in an
append-only history scoped to owner and workspace. A successful SQL receipt is
returned after the injected transaction commits. Operational reads withhold
references and preserve operation IDs, digests and correction lineage.

## Usage

The server supplies the database, clock, IDs, observer and published Jini scrubber.
Factory calls start no services and perform no I/O.

```ts
import {
  createAuditService, createSqlAuditRepo, createJiniAuditRedactor,
} from "@open-marketing/audit";
import { redactSecrets } from "@jini-ai/core"; // host dependency, public 0.4.3 API

const repo = createSqlAuditRepo({ db, clock, ids, observer });
const redactor = createJiniAuditRedactor({
  scrubber: { redact: ({ text }) => redactSecrets({ input: text }) },
});
const audit = createAuditService({ repo, clock, ids, redactor }, { observer });

const receipt = await audit.record({ context, entry: {
  operationId, kind: "intent", argumentsDigest,
  references: [securedEvidenceId],
} });
if (!receipt.ok) return receipt; // required barrier before starting a new effect

const page = await audit.list({ context, query: { limit: 100, operationId } });
```

Keep the returned `entryId` when appending a correction: set `kind: "correction"`
and `correctionOf: entryId`. The target must already exist in the same scope and
operation. Original entries are never replaced. Audit does not dispatch effects;
callers must enforce the required receipt barrier.

## Adapters and bounds

- `createMemoryAuditRepo({ clock, ids }, { maxEntries? })` is an instance-local
  test double, bounded to 10,000 entries by default. Capacity failure retains history.
- `createSqlAuditRepo({ db, clock, ids, observer })` uses feature-owned
  `AuditSqlDatabase`/`AuditSqlSession` ports and only `audit_entry`. The server
  bridge owns connections, serialized writers (`BEGIN IMMEDIATE` on SQLite),
  cancellation, native lock timeouts and disposal. No feature runtime imports a driver.
- `createMemoryAuditRedactor({})` withholds every reference; it is a conservative
  double, not a lexical secret detector. The Jini adapter additionally rejects
  identities changed by the injected published scrubber. No secret patterns are copied.
- `createMemoryAuditObserver({})` captures bounded, cloned status events. Core
  observation carries operation/outcome and correlation/trace/run IDs, never entries,
  references, raw exceptions or SQL. Telemetry failure cannot invalidate a commit.

Queries request 1..100 entries and return at most one continuation cursor. A null
cursor ends the current scan. An empty page cannot claim a continuation; cursors
must advance and belong to the same scope and operation filter. Follow cursors to
export incrementally; there is no unbounded export buffer or snapshot guarantee
across multiple requests. Reads cancelled during the final await fail explicitly.

Entry inputs allow at most 64 references (each <=256 characters); serialized entry
and context strings are bounded to 32,768 and 8,192 characters respectively. Unknown
payload fields, invalid digests, malformed adapter replies, contradictory SQL
metadata and duplicate/out-of-order SQL page identities fail closed. IDs exposed as
receipts/cursors use letters, digits, colon, underscore or hyphen.

An opaque shape is not a guarantee of anonymity. Composition must allocate
non-personal operation, receipt and telemetry IDs, and may supply exact secrets
through Jini's public redaction options. Recognized sensitive evidence identities
fail rather than being rewritten and breaking lineage.

## Evidence security and integration

`references` identify **caller-secured** exact-review/provider evidence; do not put
raw arguments, tokens or personal data in them. The repository is a trusted server
boundary. The digest/reference contract provides linkage, not encryption or a
separate secure evidence store. Host storage, access control and retention/key
recovery decisions remain explicit integration work.

Migrations `0001_audit.sql` and `0002_audit_sqlite_immutability.sql` are additive,
feature-owned and unapplied by this job. The second adds SQLite UPDATE/DELETE
guards; a future PostgreSQL composition needs equivalent enforcement. No retention,
deletion or purge policy is invented. Never blindly retry an uncertain commit;
reconcile against operation history first.

Deferred: server DB/composition and HTTP/CLI/studio wiring; secure exact-review
evidence storage; explicit retention/export-job policy. The accepted `AuditService`
has `record` and bounded `list`, so no additional export factory/table is introduced.

## Verification

One behavioral B1 repository suite targets the memory double and real disposable
SQLite adapter. Redactor, observer and DB/session suites cover their doubles and
injected adapters. Restart, append-only SQL guards, required-intent failure,
redaction, corrections, concurrency and tainted-output regressions are written.
The Jini adapter suite currently injects a scrubber double; running it against the
actual package requires adding `@jini-ai/core@0.4.3` to this package's test dependencies
through the coordinator. No direct dependency or local shim was added here.

Per the dispatch override, tests are **written, not run**; builds, lint and
`om:check` are not run.
The sole authorized verification command is
`corepack pnpm --filter @open-marketing/audit typecheck`. See `HANDOFF.md` for its
result and integration needs.
