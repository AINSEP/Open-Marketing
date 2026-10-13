# Programmer(Direct): media-library continuation — 2026-10-12

OM now wraps Jini 0.5.6 assets with marketing rights/provenance/cost evidence, guarded URL ingestion and versioned placement crops. Example: record a generation estimate, import its expected content digest with rights evidence, then request `ad-square` version 1; the original stays intact. New URL ingestion requires the server's guarded egress and bounded image inspection bindings. Real DNS/peer/redirect and codec acceptance, durable canonical repositories/audit and app wiring remain deferred.

## Inputs and continuation

Read the Programmer persona, AI-Dev-Shop entry point, relevant implementation/security/testing/documentation guidance, authoritative current index/ports/types, development/JOBS.md and COMMON.md, architecture §4.9 and dependency/constraint references. Inspected `git diff 59db645 3e2648f -- features/media-library`, prior HANDOFF, current source/tests and the installed CMS declarations/implementation. Continued the committed implementation; evidence/SQL/service/preset algorithms and migration were retained. No preserved feature source was listed in JOBS.md.

The direct dispatch authorizes this bounded continuation. Prior pattern priming (injected object parameters, public Jini adapters, explicit Outcomes) remains the style contract. No fresh approval round was introduced. Graph MCP capabilities are unavailable in this session; discovery used direct authoritative feature/package reads. npm verification was attempted through registry and npm package pages, but the web tool returned inaccessible/cache-miss errors. Installed `package.json`, public exports and declarations are the version/API evidence.

## CHANGED FILES

All writes are inside `features/media-library/`; no dependency/manifests/lockfile, other lane, app, development file or AI-Dev-Shop file changed. No commit/push.

- `src/import-adapter.ts` (new): public Jini guarded fetch/type/byte/filename/upload composition; request and response schemas; scoped digest dedupe; expected-hash validation; decoded image policy; bounded correlated egress.
- `src/import-upload.ts` (new): create-only byte adapter behind Jini upload, attempt-owned row tracking, public Jini rollback/tombstone compensation, explicit cleanup failure.
- `src/image-inspection.ts` (new): injected host decode/metadata adapter, strict fingerprint double, bounded decoded edge/pixel/frame policy.
- `src/blob-adapter.ts`, `src/jini-media.ts`, `src/transform-adapter.ts`: CMS 0.5.6 public object signatures; optional strict crop inspection before publication and on cache reads.
- `src/validation.ts`: preserve/validate CMS 0.5.6 optional `createdBy` attribution rather than rejecting canonical uploaded records.
- `src/boundary.ts`: sanitize importer validation exceptions and preserve owned typed failures across Jini's throwing ABI.
- `src/memory.ts`: configured URL fixture ingestion instead of universal deferral; empty fixture convenience remains explicitly unavailable; optional inspection injection for transform double; new repository constructor objects and injected epoch-clock adaptation.
- `src/ports.ts`, `src/types.ts`, `index.ts`: additive inspection seam/types and real import/inspection factory exports; obsolete importer comments updated.
- `tests/import-adapter.test.ts`, `tests/import-fixture.ts` (new): strict injected egress fixtures, end-to-end service/import evidence, bounds, cancellation and upload failure cases.
- `tests/adapter-failures.test.ts`, `tests/contract/port-suites.ts`, `tests/contract/memory.test.ts`, `tests/contract/adapters.test.ts`: importer/inspection B1 behavior, dimensions/cache/clock regressions, new Node public storage export.
- `README.md`, `HANDOFF.md`, `PROGRESS.md`: current API/composition/limits/evidence and continuation record.

## Reuse

Reused installed/published `@jini-ai/cms@0.5.6` public `media`, `media/import` and (tests) `media/node`: `fetchImage`, `parseImportUrl`, `buildImportFilename`, its byte validator through fetch, `sniffContentType`, `uploadMedia`, `rollbackUploadedMedia`, `tombstoneBlobIfUnreferenced`, existing canonical read/list/registry/rendition services, hashing/key/lock helpers, repositories, blob and transformer doubles, `LocalFsBlobStore` and typed errors.

No upload/hash/rendition/fetch/DNS/redirect/codec algorithm was reimplemented. The URL importer no longer needs an upstream export: 0.5.6 resolves that previous NEED. No compatibility shim is used for the media seam. The structural injected SQL seam stays unchanged because OM owns the database binding and CMS does not publish durable canonical repositories. A decoder binding is still necessary because the published transformer returns bytes/type, not decoded metadata. The feature does not import a new package or install anything.

## CONTRACTS

Existing MediaLibrary, original owned port methods, factory dependency contracts and DTO fields remain compatible. Minimal additive changes:

- `ImageInspectionPort.inspect({ context, bytes, contentType, maxPixels }, options?)`, `ImageInspection` and `ImageInspectionLimits`: required for importer admission; optional for the existing transform adapter. The host codec must enforce pixel limits before allocation and bound execution. This fills the missing decoded-dimension seam without pretending Jini's byte-only transformer exposes metadata.
- `createJiniGuardedAssetImport` and its public dependency type reuse public Jini HTTP/outbound-guard shapes; `createImageInspectionAdapter`, `createMemoryImageInspection` and default limits are exported.
- Memory importer accepts optional shared Jini dependencies and exact URL/byte/image fixtures. Empty-object calls still return `not_implemented`; configured calls execute the shared import policy.
- Transform factory options accept `inspection`. Without it, the injected codec retains responsibility for actual pixel validity; memory transform success alone is not dimension acceptance.
- CMS creator attribution is admitted by the schema and preserved on projected records. Public Jini `MediaRecord` already carries this optional field; no competing DTO was created.

Marketing provenance is the caller's immutable evidence. The service preserves every operation's record and intentionally does not rewrite it using fetch results. A distinct requested/final-redirect receipt is not part of the current repo contract; transport final URL is validated and used by Jini filename handling.

## TESTS

Owner override: tests are **written, not run**. No vitest, test suite, `om:check`, gate-tests, lint, build, install, vendor call, spend or live migration was run. No runtime red/green claim or coverage metric is possible.

Retained paired memory/SQLite metadata and memory/real temporary-filesystem blob suites. Extended the SAME importer and inspection suites for configured doubles and injected adapters. The import adapter exercises actual public Jini services with in-memory canonical repositories and strict fake egress; the inspection adapter exercises the host decoder ABI with fixture metadata. Neither is proof of a live DNS/peer/redirect policy or real image codec.

New adversarial cases: concurrent same-digest imports preserve per-operation evidence and one canonical asset; digest mismatch; scheme/credential refusal; byte truncation/coarse-vs-precise flags; unsupported actual MIME; status/redirect/tainted reply refusal; decoded edge/animation limits; abort during decode; driver failure after blob/rendition publication; cleanup and explicit later retry; wrong placement pixels before storage and in cached renditions; evidence retained after failed ingress and later linked.

Regression targets: CMS 0.5.6 public signatures and optional creator field; legacy implementations used removed string signatures and rejected new canonical records. Regression tests are written; red/green execution is prohibited, so no verified bug-fix claim is made.

Verification commands:

- `git diff --check -- features/media-library`: passed (static whitespace check).
- `corepack pnpm --filter @open-marketing/media-library typecheck`: ran once; **failed**, exit 2. Production compilation reported four TS2554 constructor errors at `src/memory.ts:21-22` and TS2353 for `Clock.nowIso` at line 23. Consequently test compilation did not run. Installed declarations/implementation confirm repository constructors now take `{}` and kernel Clock is `nowMs(): number`. Corrected those five errors and added the injected-timestamp regression; **not rerun**, so the correction and test compilation remain unverified. No unrelated-lane failure was reported.
- Package test/build and `corepack pnpm om:check`: not run by binding owner override. No claim is made about another lane's gate results.

## MIGRATIONS

No new migration. Retained `migrations/0001_media_evidence.sql` from 3e2648f unchanged; never applied. Test fixtures apply it only to isolated databases when the Coordinator runs the suites.

## Architecture audit / documentation / quality

Static audit: WARNING because runtime/mechanical verification is deferred. Checked lane ownership, public Jini exports, pure shared-contract imports, caller-owned ports, no sibling internals/policy/vendor imports, inert factories, injected I/O/clock/IDs, append-only evidence, source preservation, typed failures, no retry loop and correlation/trace/run propagation. No known out-of-lane edit or forbidden import. New owned interfaces use at most two object parameters. Foreign Jini/Vitest callbacks retain narrow documented ABIs.

| Assessment unit | Disposition | Finding / local fix |
| --- | --- | --- |
| Import adapter and egress wrapper | INCONCLUSIVE | Runtime guard proof unavailable. Scope/schema/hash/bounds before publication; injected per-hop guard is the only egress path. |
| Upload tracking/compensation | RECOMMENDED | Medium: Jini has no atomic/crash-safe blob publication or orphan sweep; per-attempt rows are rolled back/tombstoned, unknown bytes retained for reconciliation. Cross-process safety needs host transactions. |
| Inspection adapter/double/policy | INCONCLUSIVE | Real decoder not bound. Input/output schemas, copies, pre/post cancellation and full frame/pixel totals are independently testable. |
| Crop source/output/cache checks | INCONCLUSIVE | Strict metadata mismatch tests written; real pixel proof deferred. Validation extracted from transformer callback to keep concerns small. |
| Existing canonical listing | RECOMMENDED | Medium, inherited: Jini materializes unpaginated workspace records before the 1,000-record cap. Need a bounded public query. |
| Public signature/creator adaptation | INCONCLUSIVE | Regression suites written; the single final typecheck is the only authorized mechanical proof. |

No known Critical/High semantic finding remains from static review; lint metrics are unmeasured. Coverage is unmeasured by owner override. Source branches are reachable through injected guard/decoder/repos/store and shared suites; no coverage suppressions. Old importer deferral-only expectations were replaced with stronger ingestion behavior; empty-fixture unavailability remains covered by retained service tests. Other existing behavior tests were retained. Variable names were checked against computed values. Findings exist, so a zero-findings skepticism pass is not applicable. No numeric function-quality score is claimed.

Documentation: new public factories/types/inspection port, effect ordering and bounded-policy helpers documented; stale release/import/codec guidance updated; trivial private mappers and standard callbacks intentionally avoid repetitive comments. Inline complexity notes identify input buffers, pixels and upstream workspace scans. Self-validation was not run because the owner prohibits runtime/test/build checks; no UI/app startup was attempted.

Pre-completion: authoritative requirements reread; existing behavior tests retained; all edits scoped to media-library; migration untouched; open acceptance explicitly listed. Pipeline certification/outline/critical-constraints artifacts were not supplied for this direct dispatch; the authoritative contract and explicit lane/engineering constraints governed implementation.

## RISKS / NEEDS

- NEEDS: server bind the published platform guarded HTTP client/OutboundGuardPort and certify actual DNS/IP/peer pinning and every redirect. Feature package does not list `@jini-ai/platform`; if the Coordinator wants a feature-owned integration suite, add `@jini-ai/platform@0.5.3` to this package. It was not installed/imported here.
- NEEDS: host or public Jini bounded full-image inspection/decoder binding (metadata, pre-allocation pixel cap, frames, timeout/cancellation), plus real-codec placement-dimension acceptance. Do not admit production URL imports without this binding. Bind inspection for strict production crops.
- NEEDS: durable Jini canonical repositories and idempotent MediaAuditPort; authenticated contexts and globally unique workspace-to-owner mapping.
- NEEDS: Jini/host crash-safe atomic blob publication, orphan reconciliation/GC and database-backed cross-process import/transform/cleanup serialization. A partial/torn write is an explicit failure and may remain quarantined, never silently retried or speculatively deleted.
- NEEDS: bounded upstream listing/query API; decoded/worker execution deadlines; Coordinator-owned HTTP + studio + CLI/outbox integration.
- Supplied provenance remains immutable; if durable requested/final redirect receipts are required separately, the evidence contract needs an explicit append-only receipt extension.
- Tests/lint/build/combined acceptance remain unverified. Memory codecs/HTTP fixtures cannot certify real security/pixels.

## HANDOFF

PARTIAL for Coordinator combined verification and server binding. The working adapter/core and tests are reviewable; no runtime/security/codec acceptance is asserted. Next assignee: Coordinator/TestRunner for one combined verification, then server integrator for guarded client/decoder/durable bindings and HTTP/studio/CLI closure. There was no commit or push.
