### 2026-10-29-w22-grant-surfaces: verdict READY TO COMMIT (two MINOR audit/UX notes; measure dist rebuild before runtime)

Ledger:
- APPROVED 1, sql-grants.ts race fix + list (FIX 4, 6): FIXED.
  - features/measure/src/adapters/sql-grants.ts:49 is now `INSERT … ON CONFLICT (scope_key, grant_id) DO NOTHING`. Then :50 reads back the row and :53 does a canonical compare, `{...stored, revoked:false}` vs grant: a mismatch is `conflict`, otherwise the stored grant is returned (a revoked grant is not resurrected).
  - The pre-read is gone and the work runs in the same transaction.
  - `list` (:22-33) is a scoped keyset query: `grant_id > $2 ORDER BY grant_id LIMIT limit+1`, cursor = the last item. Revoked grants are included.
  - Row decoding is shared through `decodeGrant` (:81-89), used by both `readGrant` and `list`.
  - No port, memory or index edits.
- APPROVED 2, SQL-only race regression + list test: FIXED.
  - features/measure/tests/sql-fixture.ts:21,65 `raceNextGrantInsert` is the one-shot seam.
  - contract/sql.test.ts:21-27 identical competitor → ok + 1 row; :28-34 different content → conflict; :35+ paging, scope isolation, revoked included, final `cursor:null`.
  - The identical-competitor test would fail on the old SELECT-then-INSERT (PK violation → unavailable), so it is a real regression.
- APPROVED 3, composition/conversions.ts: FIXED.
  - :10 `CONVERSION_PAYLOAD_SCHEMA = 'om.conversion'` matches the dispatcher's `payloadSchema` (dispatcher.ts:18,116).
  - :12 `grantFieldsSchema` omits scope/kind/revoked/payloadSchema/payloadVersion; :30-31 the server fills them.
  - :46 non-owner → forbidden.
  - :48-58 grant/revoke and the audit run on one joined session. om-db's session `transaction` joins rather than nesting (packages/om-db/src/transaction.ts:77-80), and a returned failed Outcome or throw rolls back (:117-123).
  - An audit failure throws, so the transaction rolls back, and the caller gets a typed `unavailable`.
- APPROVED 4, catalog.ts one property: FIXED. composition/catalog.ts:55 adds `measurementGrants: bindMeasurementGrants({ database: required.database.workspace, … })`. It reaches services through the existing `Object.assign`, with zero bootServer edits. The other catalog.ts hunks vs HEAD (sharp/brand/media imports) belong to earlier waves.
- APPROVED 5, om-tools: FIXED.
  - apps/server/src/om-tools.ts:734 adds the service type; :942-953 `measurementGrantDefinitions` returns `[]` when absent; :1064 is the unconditional push in `scopedDefinitions`.
  - Tools: list is read with `pageQuerySchema`; grant/revoke are write + `ownerOnly: true`.
  - `featureDefinitions` is unchanged.
- APPROVED 6, coverage: FIXED. om-tool-coverage.ts:83-85 has the three rows, :91 the 'Vendor conversions' reason updated with the W23 NEEDS, and :159 the Integrations label.
- APPROVED 7, Studio: FIXED.
  - pages/addons/model/conversion-grants.hooks.ts:
    - imports contract schemas directly (no shared/api edit);
    - takes plain bounded inputs, with expiry = `runtime.clock.now + N*86400000` (:104-109);
    - a pending result reads the card and verifies cardId + operationId (:41-48);
    - success is shown only after the operation reads `completed`, followed by a reload (:58-63);
    - an uncertain outcome keeps the operation and blocks new writes (:85, :116).
  - ConversionGrants.tsx is new; IntegrationsPage.tsx gets an import + mount. The rest of that file's diff vs HEAD comes from earlier and parallel jobs (w22-conversion-settings etc.).
- APPROVED 8, tests (written, not run): FIXED.
  - (a) measurement-grants.test.ts:28/40/51: owner flow + fixed metadata + audit, non-owner + caller metadata rejected, audit-failure rollback.
  - (b) om-tools.test.ts:1607+: one `it` on the shared dispatcher (three tools, ownerOnly, card, no operationScope, Cancel persists nothing, Allow persists).
  - (c) conversion-grants.test.ts: four Studio lifecycle tests.
- APPROVED 9, typecheck: FIXED. Per typecheck.txt: measure PASS; server PASS; studio failed on test types (ATTEMPT 3), then PASS on the rerun (ATTEMPT 4); measure re-run PASS.
- COORDINATOR OVERRIDE 1 (W23 deferred) and 2 (merge on top of conversion-settings and P1-5): FIXED. P1-5's `reportingDefinitions` and the conversion-settings hunks are intact next to this job's hunks.

Outside lane: none. All edits are in LOCKS-FILES. No contracts, package.json, lockfile, migration or dist edits.

New:
- [MINOR] apps/server/src/composition/conversions.ts:51-56: a replayed `grant` writes a second `grant_created` audit row on success.
  - Replays come from an identical retry, or from the same grantId after a revoke, when sql-grants.ts:53 returns the stored revoked grant as `ok`. A replayed `revoke` likewise writes another `grant_revoked` row, because the UPDATE at sql-grants.ts:62 is a no-op.
  - Failure: the audit shows "grant_created" for a grant that is still revoked. Studio then says "Conversion sharing granted." (conversion-grants.hooks.ts:62) while the row shows Revoked.
  - It is rare in practice: Studio mints a fresh grantId per submit, and the dispatcher dedups by operationId.
  - Fix (optional, 1 line): in `changeGrant`, when `required.grant && result.value.revoked`, return `localFailure({ code: 'conflict', message: 'Measurement grant was revoked' })`. That also rolls back the audit.
- [NOTE, runtime] conversions.ts:5 imports `createSqlMeasurementGrant`/`createSqlMeasureAudit` at runtime from `@open-marketing/measure`, which resolves to ./dist/index.js (features/measure/package.json:12).
  - The dist is stale (Oct 14) and does not export `createSqlMeasurementGrant`, so a server boot from source would fail at this import until the Coordinator rebuilds the dist.
  - It is the same NEEDS as P1-5. Not a defect of the job, but it must happen before runtime validation.
- Complexity by reading: `refreshData` (hooks :50-73) is about 9-10: if, if, if+||, switch, then nested if/if at +2. At the limit. Everything else ≤7. Nesting ≤3.
- Secrets/vendor names: none. No capability or credential caching.

Duplicates (vs published Jini rc.2 / Tovu): none.
- No measurement or conversion-grant store in the rc.2 dist or Tovu.
- The conflict-safe insert follows OM's own precedent (features/workspaces sql-store ON CONFLICT).
- The approval card is OM's single confirmation exchange.

Disputes/deferrals:
- W23-CONVERSION-PRODUCER-WORKER (CUT 1): DEFERRED-OK. Production stays fail-closed, because `measure.conversion` is still unbound in workers.ts.
- Studio connection picker: DEFERRED-OK.

Typecheck: all three packages PASS (studio on its rerun).

Net lines: +556 / −16 = +540 (source +268, tests +272).

Small fixes (optional):
1. apps/server/src/composition/conversions.ts:53: after `if (!result.ok) return result;`, add `if (required.grant && result.value.revoked) return localFailure({ code: 'conflict', message: 'Measurement grant was revoked' });`. This stops a replay from auditing "grant_created" on a revoked grant and keeps Studio from showing "granted".
2. Coordinator: rebuild the `@open-marketing/measure` dist (shared with P1-5) before boot or test validation.
