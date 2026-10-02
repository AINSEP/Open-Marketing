# Programmer(Direct): media-library handoff

OM now adds rights/provenance/cost evidence and versioned placement crops to Jini-owned canonical assets. For example, record an estimated generation cost before output exists, then create an `ad-square` crop from an existing Jini asset. URL ingestion is deferred until the public Jini importer is exported; durable canonical storage, real codec acceptance and app integration remain with the host/Coordinator.

## Changed files

All edits are inside `features/media-library/`. No root manifest, lockfile, shared contracts, app/platform, sibling feature or AI-Dev-Shop file was changed. No commits or pushes.

- `src/service.ts`: inert, validated orchestration for all service methods; known-digest association preserves each operation's evidence; uncertain results are explicit.
- `src/validation.ts`, `src/rules.ts`, `src/boundary.ts`: schemas aligned with j00's final Jini-based contract, preset decisions, typed error containment and correlation telemetry.
- `src/memory.ts`: functional scoped doubles for all original owned ports, plus a bounded observer and Jini dependency fixture. Importer remains explicitly deferred.
- `src/evidence-repo.ts`, `src/sql.ts`: one append policy over memory/SQL stores; immutable provenance roots, later associations, estimated/actual/corrective costs and crop links.
- `src/jini-media.ts`, `src/blob-adapter.ts`, `src/transform-adapter.ts`: public Jini wrappers, scope enforcement, byte integrity/copying, bounded buffer/codec work and immutable placement geometry.
- `index.ts`: additive exports for real adapters, structural SQL connection type and memory composition/observer helpers.
- `migrations/0001_media_evidence.sql`: additive OM evidence schema, never applied.
- `tests/`: behavioral B1 suites, memory/injected registrations, temporary filesystem/SQLite compositions, service/failure/concurrency cases and helpers.
- `README.md`: usage, bounds, release limitations and integration instructions.

## Contracts

`src/ports.ts` and `src/types.ts` are unchanged. Existing public factory names and `createMediaLibrary` required/optional dependencies are preserved. Memory factory arguments widen from empty objects to optional `scope`/Jini dependencies (old `{}` calls remain valid). Shared dependencies are essential for a transform double to observe canonical assets populated by the media double. Default scope for convenience doubles is the explicitly documented `owner`/`workspace` test scope.

`index.ts` adds `createJiniMediaAdapter`, `createJiniBlobStore`, `createJiniImageTransform`, `createSqlMediaRepo`, `MediaSqlPort`, `createMemoryJiniDependencies`, and `createMemoryMediaObserver`. The SQL query type structurally matches the server-owned compatibility connection; no driver is imported in production feature code.

Stale `validation.ts` schemas described pre-Jini asset/crop/provenance shapes. They now validate the authoritative `record`/`blob` asset shape, full marketing provenance and placement/version crop requests. This is contract alignment, not a change to published DTOs.

## Reuse / discovery

Installed `features/media-library/node_modules/@jini-ai/cms` is 0.3.11. Read its published exports/declarations and algorithm source before implementation. Reused public `getMediaById`, `listMedia`, `registerTransform`, `resolveMediaRendition`, `computeBlobStorageKey`, HTML attribute validation, type sniffing, error classes, lock helpers and all published in-memory repositories/blob/image-transform doubles. Tests seed via public `uploadMedia` and use public `LocalFsBlobStore` for real temporary storage. OM does not rebuild upload, hash addressing, resizing, rendition or registry algorithms.

Not reused: public URL importer (no `./media/import` export); SQLite canonical repositories (release delegates them to the host); actual Sharp codec (not installed/admitted here). Registry recheck attempted through web and bounded curl; web could not open the release URL and sandbox DNS could not resolve registry.npmjs.org. Installed release plus authoritative dispatch are the evidence; no claim of a fresh successful npm lookup.

Graph-first discovery queried the indexed `Users-la-Programming-Open-Marketing` project and returned no media-library symbols. Direct reads were used for the current contract and installed package after that insufficient result. No expensive graph refresh was needed on the shared machine.

## Tests and verification

Owner's NO TEST RUNS override governs: test suites, vitest, lint, `om:check`, builds and install are **written, not run**. No red/green bug-fix claim and no coverage percentage. The one permitted package typecheck was run; exact evidence and the unverified follow-up correction are recorded below.

Shared suites are behavioral rather than j00 stub-absence assertions. SQL suite uses actual isolated SQLite, and blob suite uses actual temporary filesystem storage. Jini injected adapters use published in-memory repositories/transform double: they establish adapter behavior, not durable canonical or real-pixel codec acceptance. Audit has an in-memory double only; host supplies its durable binding.

Adversarial cases: conflicting repeated provenance/cost keys; currencies/correction target scope; foreign owners/workspaces; concurrent duplicate blob writes and crop generation; partial/torn byte writes; tainted upstream records; changed preset geometry; original mutation by a transformer; failure evidence and audit failure followed by retry. No live vendor calls, spend or live migrations.

## Architecture audit / style

Static audit status: WARNING (runtime/mechanical combined verification deferred by owner). Checked public imports, lane ownership, Jini ownership, injected I/O, inert factories, caller-owned ports, no policy imports, source immutability, append-only metadata, typed error paths and correlation propagation. No identified out-of-lane edits or forbidden cross-feature imports. All owned signatures use at most two object parameters; standard array/Zod/Vitest/driver callbacks retain their foreign ABI. Jini upstream functions are called through public exports, never deep-imported.

Pattern priming used the dispatched skeleton's existing two-object signatures, injected ports and Outcome pattern; task authorization governed implementation without a separate style approval round. Pipeline-specific certification/outline/memory/ADR-index artifacts were absent; direct dispatch supplied authoritative architecture and lane constraints. No speculative framework was introduced.

| Assessment unit | Disposition | Findings / local fixes |
| --- | --- | --- |
| Schema/context/preset rules | INCONCLUSIVE | Static review complete; mechanical/test execution unavailable by override. Old DTO schema replaced with final contract shapes. |
| Evidence orchestration / memory / SQL | INCONCLUSIVE | Paired suites written; runtime proof pending. Root-before-link preserves evidence on partial failure. Canonical serialization avoids property-order retry conflicts. |
| Canonical wrapper / pagination | RECOMMENDED | Medium: upstream unpaginated listing allocates before OM can cap it; request a bounded upstream repo/service. OM work capped at 1,000 rows and 100 projections. |
| Blob wrapper | RECOMMENDED | Medium: upstream torn writes lack crash-safe publication; retain uncertain content and require reconciliation. Hash integrity checks prevent false success. |
| Transform wrapper / geometry | RECOMMENDED | Medium: decoded-pixel and cross-process execution guarantees require real codec/host worker acceptance. Input/output buffers are capped and copied; metadata/presets validated. |
| Service orchestration / telemetry | INCONCLUSIVE | Direct failure/scope/idempotency tests written; runtime proof pending. Error messages contain no raw dependency details; observer failure cannot alter effects. |

No numeric function quality score. Complexity is documented on nontrivial boundaries; cognitive/nesting measures are not claimed without the prohibited lint run. No known Critical/High static finding. Coverage is unmeasured because tests are prohibited. Test seams cover effects directly through owned ports and injected dependencies. Variable-name audit performed, including distinction between OM preset version and Jini transform version. Findings exist, so the zero-findings skepticism trigger does not apply.

Documentation classification: stale docs updated on service/memory/validation and README; new exported factories/types and complex effect/invariant helpers documented; obvious private mappers and foreign test callbacks intentionally have no repetitive line-by-line docs.

## Migrations

One additive, portable SQL file creates `om_media_evidence` and its operation index. It stores marketing evidence/crop links only. It is not applied to a live database. Test fixtures will apply it only to isolated memory/temp databases when Coordinator runs tests.

## Risks / NEEDS

- NEEDS: upstream public `@jini-ai/cms/media/import` export plus guarded importer acceptance for SSRF/DNS/redirect/MIME/size/decoded-dimension rejection and cleanup. Until then URL ingress remains `not_implemented`.
- NEEDS: bounded public Jini listing/query seam; current upstream list is unpaginated before OM's cap.
- NEEDS: Jini/host atomic byte publication and orphan reconciliation/GC for partial blob/rendition writes; wrapper does not speculatively delete digest-addressed shared objects.
- NEEDS: server composition bind authenticated contexts, globally unique workspace-to-owner mappings, durable Jini repositories, durable idempotent MediaAuditPort, image codec and execution/cancellation timeouts. Jini supports workspace scope only, so server authentication and ownership mapping remain mandatory.
- NEEDS: Coordinator-owned HTTP + studio + CLI/outbox/worker integration; out-of-lane code untouched.
- Unknown external adapter outcomes never receive automatic retries. Costs are marketing evidence, not spend authorizations or ledger totals.

## Handoff

PARTIAL implementation handoff for Coordinator combined verification. Required acceptance for missing importer, real codec dimensions and upstream cleanup is explicitly deferred. Source and tests are reviewable; no test/build/lint acceptance is claimed. Next: run combined verification once, resolve any failures in this lane, bind server dependencies and apply the reviewed migration through the authorized migration operation.

Typecheck evidence: ran `corepack pnpm --filter @open-marketing/media-library typecheck` once. Production `tsc --noEmit` passed. Test compilation failed with one TS4058 diagnostic at `tests/sql-fixture.ts:21` (an inferred exported return type referenced the SQLite namespace). Added an explicit `Promise<{ db: MediaSqlPort; database: Database.Database; dispose: () => Promise<void> }>` return annotation. No rerun under the one-typecheck override; the correction remains unverified until Coordinator combined verification. No unrelated-lane typecheck failure was reported.
