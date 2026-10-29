# Trim review: 2026-10-29-w22-grant-surfaces
VERDICT: APPROVED WITH CUTS

No coordinator-note.md exists. The coordinator's 10-29 message about the Studio page is applied in FIX 8.

Facts checked against the current tree:
- The SQL grant store exists (`features/measure/src/adapters/sql-grants.ts:17-55`) with `current/grant/revoke`. The insert race is real: SELECT then plain INSERT (`:34-41`).
- The migration collision the plan calls DISPUTED is fixed: `composition/migrations.ts:33` registers v28 / measure local 5. Agreed.
- Nothing in production enqueues `measure.conversion`. The only enqueues are in tests (`agent-plugin-jobs.test.ts:216,526`, `ingress-worker.test.ts:142`). Production ingestion enqueue is a stub that returns forbidden (`composition/index.ts:328`). `createFormWorkers` is called only inside `bootServer` (`index.ts:384`) and gets no `conversions`, so `workerEnabled` keeps `measure.conversion` denied (`workers.ts:257`).
- `paidSending` is the exact precedent for an owner-only service on all surfaces with no `bootServer` edit:
  - `bindCatalogScope` returns it (`composition/catalog.ts:48-54`).
  - `Object.assign(services, catalogScope, …)` puts it on services (`index.ts:337`).
  - om-tools declares it (`om-tools.ts:729`) and adds two `serviceDefinition`s, the write one `ownerOnly` (`:1021-1025`).
  - HTTP uses `/api/tools/call`, the CLI uses `om tools call` and the agent uses `execute_tool`. Nothing else is needed.
- `ownerOnly` omits `operationScope` (`om-tools.ts:580`) and disables retained-grant reuse (`:378`), so there is no "Always allow". Writes run only after `answer()`, which requires an owner principal (`:461`) and invokes with the answering owner's context (`:487`, `:310`).
- `featureDefinitions` is at cognitive complexity 10, with ten `if (services.x)` lines (`om-tools.ts:976-990`; also w21-p1-5 review FIX 1).

CUTS:
1. **Production conversion-worker composition** (plan §3 `bindConversions…worker`, §4 steps 6–8): `loadSqlConversion`, the `verification.ts` edit, the `features/measure/index.ts` export, grant matching via `readBoundedPages`, the production `loadEvidence`/identifiers/ledger wiring, and the `agent-plugin-jobs.test.ts` real-worker test. DEFERRED as **W23-CONVERSION-PRODUCER-WORKER** for these reasons:
   - (a) It cannot be live. Its only call site is in `bootServer` (`index.ts:384`), which this job must not touch.
   - (b) There is no producer. No production code enqueues `measure.conversion`, and ingestion enqueue is a forbidden stub (`index.ts:328`). The binding would be dead code.
   - (c) Choosing the grant belongs in the durable intent: put `grantId` in the job payload when the producer is built. The plan itself defers this (§8). The "scan all grants for exactly one match" would be thrown away.
   - (d) Size: the plan estimates +715–985 LOC, more than one ≤90-min build.
   - (e) It collides with w22-conversion-delivery-diagnostics on `agent-plugin-jobs.test.ts` and `port-suites.ts`, and with the w15-backends lock.

   Production stays fail-closed, as job item 2 requires, because the worker stays unbound (`workers.ts:155`, `:257`).
2. **Grant-time account/connection ownership validation** (plan §4.2). Dispatch already checks that the account binds to the connection in scope, through `bindingCurrent` (`agent-plugin-backends.ts:946-953`), before any egress. The "scope mismatch" check duplicates `sql-grants.ts:32`. Cut both.
3. **"Reject expired creation input"** (plan §4.2). Expiry is already enforced at dispatch by `validateGrant` (`dispatcher.ts:109-118`) and A3 `conversionCurrent` (`agent-plugin-backends.ts:837`). The owner sees the exact expiry on the card. Cut.
4. **Studio `shared/api/validation.ts` and `shared/api/index.ts` edits.** The hook imports `measurementGrantSchema`/`pageQuerySchema` from `@open-marketing/contracts` directly (precedent: `pages/tracking/model/tracking.hooks.ts:5`). This also drops the plan's w14-surface lock.
5. **`apps/server/src/cli/index.ts` help examples.** The generic `om tools call <name> --input-file <path|->` already covers these tools (`cli/index.ts:38,95,119`). Paid-sending has no CLI-specific text either. No CLI edit.
6. **Shared-suite race regression in `port-suites.ts`, and the suite parameterization.** Memory has no race, and SQLite can't interleave a `Promise.all`. Write a SQL-only regression instead (FIX 5). `port-suites.ts` is not touched; w22-conversion-delivery-diagnostics also edits it.
7. **Studio connection picker / "derive destination from its plugin identity".** It needs a connection-list read, which is more than the job asks for. Use plain bounded inputs (OWNER DECISION 3).
8. **The big `om-tools.test.ts` block** ("HTTP/tool/CLI approval and owner-authority regressions"). All three transports share one dispatcher, so one `it` covers them (APPROVED SCOPE 8b). Service-level checks go in a new file.
9. **NEEDS lines** "Coordinator composition: `services.measurementGrants = …`" and "confirm bundles export `createConversionDelivery`". FIX 1 removes the first. The second belongs to the deferred worker job.

FIXES:
1. **Wire the grant service through `bindCatalogScope`, not `bootServer`.**
   - In `composition/catalog.ts:48-54`, add `measurementGrants: bindMeasurementGrants({ database: required.database.workspace, clock: required.clock, ids: required.ids, observer: required.observer })` to the returned object, next to `paidSending`.
   - `required.database.workspace` is the same `SqlSession` bootServer uses as `measureDb` (`index.ts:327`).
   - The existing `Object.assign(services, catalogScope, …)` (`index.ts:337`) then puts it on services: zero `bootServer` edits, and it is live in production.
2. **om-tools: no new branch in `featureDefinitions`.**
   - Declare `measurementGrants?: ReturnType<typeof bindMeasurementGrants>` on `OmFeatureServices` (`om-tools.ts:729`), using `import type { bindMeasurementGrants } from './composition/conversions.js'` (precedent: the `bindTracking` type import).
   - Add `function measurementGrantDefinitions(required: { grants?: OmFeatureServices['measurementGrants'] }): OmToolDefinition[]` that returns `[]` when grants are absent, mirroring `trackingDefinitions` (`:925-934`).
   - Call it unconditionally in `scopedDefinitions` next to paidSending (`:1021`): `definitions.push(...measurementGrantDefinitions({ grants: services.measurementGrants }))`.
   - Tools:
     - `om_measure_grants_list` (read, `pageQuerySchema`);
     - `om_measure_grant` (write, `ownerOnly: true`);
     - `om_measure_revoke_grant` (write, `ownerOnly: true`, `{ grantId }`).
3. **Tool and grant input shape.**
   - `grantFieldsSchema = measurementGrantSchema.omit({ scope: true, kind: true, revoked: true, payloadSchema: true, payloadVersion: true })`.
   - The caller supplies `grantId`, so retries are idempotent; Studio uses `runtime.ids`.
   - The server fills `scope` from the context, `kind:'measurement'`, `revoked:false`, `payloadSchema: CONVERSION_PAYLOAD_SCHEMA` and `payloadVersion: 1`.
   - Export `CONVERSION_PAYLOAD_SCHEMA = 'om.conversion'` from `composition/conversions.ts` for the future worker. The dispatcher rejects any other value (`dispatcher.ts:115`), so callers must never choose it.
4. **Race fix shape** (`sql-grants.ts:33-42`).
   - Replace SELECT-then-INSERT with `INSERT INTO measure_grant (scope_key,grant_id,grant_json,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (scope_key, grant_id) DO NOTHING`.
   - Then `readGrant` and do the existing canonical compare: `JSON.stringify({ ...stored, revoked:false }) !== JSON.stringify(grant)` gives `conflict`; otherwise return the stored grant, which may be revoked, so there is no resurrection.
   - Delete the pre-read branch. Keep it in the same transaction.
   - Precedent: `features/workspaces/src/adapters/sql-store.ts:40-42`. The syntax is portable to SQLite ≥3.24 and Postgres, and the PK is the conflict target.
5. **Race regression is SQL-only.**
   - In `tests/sql-fixture.ts`, extend the existing `beforeQuery` hook (`:33-35`) with a one-shot seam `raceNextGrantInsert(row)`. When the query text starts with `INSERT INTO measure_grant`, it inserts the given row through `handle` first.
   - In `tests/contract/sql.test.ts`:
     - an identical competitor means `grant` returns `ok` with the stored grant (today this fails as `unavailable` on a PK violation);
     - a competitor with different content means `conflict`.
6. **`list` on the concrete SQL adapter only** (no port change).
   - Signature: `list({ context: CallContext; query: PageQuery }, options?) → Outcome<Page<MeasureGrant>>`.
   - Query: `SELECT grant_json,revoked_at FROM measure_grant WHERE scope_key=$1 AND ($2 IS NULL OR grant_id > $2) ORDER BY grant_id LIMIT $3`, with `limit+1` look-ahead. `cursor` = the last returned `grant_id`, or `null`. Precedent: `workspaces/sql-store.ts:60-63`.
   - Factor the row decoding out of `readGrant` (`sql-grants.ts:62-68`) so both paths validate the same way. Include revoked grants.
   - Return type: `MeasurementGrantPort & { list… }`.
   - Keep each method at complexity ≤10.
7. **Grant/revoke and audit commit together** (`composition/conversions.ts`).
   - Inside `required.database.transaction({ work: async ({ session }) => … })`, build `createSqlMeasurementGrant({ database: session, clock })` and `createSqlMeasureAudit({ database: session, ids, clock })`. The joined session never opens a second root transaction (`database.ts:11`).
   - Call `grant`/`revoke`, then `audit.record({ context, operationId: grantId, outcome: 'grant_created' | 'grant_revoked' })`.
   - If the audit fails, throw inside `work` so the transaction rolls back, and return a typed `unavailable` outside it.
   - Owner check: a principal other than owner → `forbidden`. This is one line and it is the service's own contract. It is not a second approval.
   - `list` is a plain read, with no audit.
8. **Studio page (coordinator 10-29 message wins over plan §4.5).**
   - Put the grant list/form in its own files:
     - `apps/studio/src/pages/addons/ui/ConversionGrants.tsx`;
     - `apps/studio/src/pages/addons/model/conversion-grants.hooks.ts`.
   - Mount it with ONE line in `IntegrationsPage.tsx`, after the Connections section (`IntegrationsPage.tsx:19`). Connections are shown on that page.
   - Do NOT edit `integrations.hooks.ts` or the conversion-settings section that w22-conversion-settings owns.
   - No `pages/measure` page exists today (`ls apps/studio/src/pages` → addons, leads, tracking). Use addons; don't wait for P1-5.
   - Tracking files are untouched, which also avoids colliding with w22-consent-banner on `TrackingPage.tsx`, `tracking.hooks.ts` and `tracking.test.ts`.
   - Card flow: reuse the BrandProfile pattern (`widgets/workspace-canvas/ui/BrandProfile.hooks.ts:135-149`: `api.tool` → pending `cardId` → `api.operation` refresh) plus `ApprovalCard` from `features/approve`, as `IntegrationsPage.tsx:76` does.
   - Never claim success until the operation reads `completed`. Then reload the list.

REUSE:
- Owner-only service exposure → `catalog.ts:48-54` + `om-tools.ts:729,1021-1025` (paidSending).
- Absent-service tool pattern → `trackingDefinitions` (`om-tools.ts:925-934`).
- Approval card, no Always allow → `ownerOnly` (`om-tools.ts:378,580`); owner answer (`:459-490`).
- Conflict-safe insert and read-back, keyset list → `features/workspaces/src/adapters/sql-store.ts:40-42,60-63`.
- Row validation → `readGrant` (`sql-grants.ts:57-69`); boundary → `sqlBoundary`/`unwrap` (`sql-boundary.ts`).
- Audit → `createSqlMeasureAudit` (`sql-delivery.ts:64-78`); joined session → `bindServerDatabase` (`database.ts:15-26`).
- HTTP/CLI → `/api/tools/call` and `om tools call` (`cli/index.ts:38,95,119`); coverage label list (`om-tool-coverage.ts:149`).
- Studio card flow → `BrandProfile.hooks.ts:135-149`; `features/approve` `ApprovalCard`.
- SQL test seam → `sql-fixture.ts:33-35` (`beforeQuery`).

DUPLICATES:
- Measurement/conversion-sharing grant store or list: none found.
  - `rg -il "measurement.?grant|conversion.?grant|sharing.?grant"` over `node_modules/.pnpm/@jini-ai+*0.6.15-rc.2*/…/dist`: no hits.
  - `tovu-integration-clones/ai-traces-jini/packages`: no measurement-grant hits.
  - `/Users/la/Programming/Tovu` (*.ts): no hits.
- Conflict-safe insert: Jini source uses inline `ON CONFLICT` in CMS-specific code only (`ai-traces-jini/packages/cms/src/entries/write-service.ts`). There is no published generic helper. The OM in-repo precedent is used (REUSE).
- Approval card: OM's own confirmation exchange is the single approval rule. Jini core gated-mutations (rc.2) is a separate ceremony, so it is not adopted and there is no JINI ASK.
- JINI ASK: none.

OWNER DECISIONS (defaults):
1. **Grant identity.** Default: the caller supplies `grantId`, and the server fixes `scope`/`kind`/`revoked`/`payloadSchema`/`payloadVersion` (FIX 3).
2. **List contents.** Default: list active, revoked and expired grants, each with its `revoked` flag and `expiresAt`. Studio labels them Active, Revoked or Expired using `runtime.clock`.
3. **Studio inputs.** Default: plain bounded inputs:
   - Connection ID;
   - Destination plugin ID;
   - Account ID;
   - Definition IDs (comma list, 1–16);
   - Purpose (prefilled `measurement`);
   - "Valid for N days" (1–365).

   Expiry is `runtime.clock.now({}) + N*86400000`. This avoids date-string timezone mistakes (`Date.parse('YYYY-MM-DD')` is UTC midnight). There is no connection picker.
4. **Revoke.** Default: owner-only with the same Allow/Cancel card, as all om-tools writes have. It takes effect on the next `current()` read, which the dispatcher and A3 do at every egress (`dispatcher.ts` `authorizeEgress`, `agent-plugin-backends.ts:832-840`).

APPROVED SCOPE for B1:
1. `features/measure/src/adapters/sql-grants.ts`: the race fix (FIX 4) and `list` (FIX 6). No port, memory or index changes.
2. `features/measure/tests/sql-fixture.ts`: the `raceNextGrantInsert` seam. `features/measure/tests/contract/sql.test.ts`:
   - two race cases (FIX 5);
   - a list test covering paging (limit 1, then the cursor), scope isolation, an included revoked grant and `cursor:null` at the end.
3. New `apps/server/src/composition/conversions.ts`: `bindMeasurementGrants(required: { database: MeasureSqlDatabase; clock; ids; observer })` → `{ list, grant, revoke }`, plus the `CONVERSION_PAYLOAD_SCHEMA` export (FIX 3, 7). Use `fn(required, optional?)`, Zod-derived types and complexity ≤10.
4. `apps/server/src/composition/catalog.ts`: one property in `bindCatalogScope` (FIX 1).
5. `apps/server/src/om-tools.ts`: the services type and `measurementGrantDefinitions`, called unconditionally from `scopedDefinitions` (FIX 2).
6. `apps/server/src/om-tool-coverage.ts`:
   - Add three capability rows (`FEATURE_COMPOSITION`, "Inject measure SQL grants via catalog scope").
   - Add the three tool names to the Studio label list at `:149`, labelled `'Integrations and chat via execute_tool'`.
   - Change the 'Vendor conversions' reason (`:87`) to say grants are owner-managed through `om_measure_grant*`, and that the production producer/worker remains NEEDS.
7. Studio (FIX 8): new `pages/addons/model/conversion-grants.hooks.ts`, new `pages/addons/ui/ConversionGrants.tsx`, and a one-line mount in `pages/addons/ui/IntegrationsPage.tsx`.
8. Tests (written, NOT run):
   - (a) New `apps/server/tests/measurement-grants.test.ts`. Use `bindServerDatabase` with the measure migrations applied, as the `p1-tracking.test.ts` setup does.
     - The owner can grant, list and revoke.
     - A non-owner gets forbidden.
     - The server fixes `payloadSchema`/`payloadVersion`/`scope`.
     - An audit failure (an injected failing audit insert) leaves no grant row.
     - Revoke writes one `grant_revoked` audit row, and `current` then reports `revoked:true`.
   - (b) ONE `it` in `apps/server/tests/om-tools.test.ts`, reusing its fixture with `services.measurementGrants`:
     - the catalog has the 3 tools;
     - the write tools are `ownerOnly`;
     - the `om_measure_grant` request has no `operationScope` and returns pending with a card;
     - cancel persists no grant;
     - allow persists the grant.
   - (c) New `apps/studio/tests/conversion-grants.test.ts`:
     - the list renders;
     - grant goes pending, shows an `ApprovalCard` and does not claim success;
     - after the operation reads `completed`, the list reloads;
     - revoke follows the same path.
9. One typecheck each for `@open-marketing/measure`, `@open-marketing/server` and `@open-marketing/studio` (one rerun allowed). Write the results to `typecheck.txt`. Keep `progress.md` updated after each item and write `report.md` at the end. No tests, builds, om:check, pnpm install or indexing.

DEFERRED:
- **W23-CONVERSION-PRODUCER-WORKER** (CUT 1) needs:
  - a production producer that enqueues `measure.conversion` with an explicit `grantId` in the payload. This changes `workers.ts` `conversionPayloadSchema` and the A3 `conversionJob` identity check;
  - the committed-event loader;
  - production `loadEvidence`, identifiers and ledger;
  - the `createFormWorkers({ conversions })` wiring in `bootServer` (Coordinator);
  - plugin dist rebuilds exporting `createConversionDelivery`;
  - retry classification for pre-send load failures (w20-jobs-lease-handoff postcheck).
- A Studio connection picker (CUT 7).

NEEDS (Coordinator):
- Lock order and overlap:
  - w21-p1-5-results (building) holds w13-server-composition, w13-om-tools and w20-measure. It edits `om-tools.ts` `featureDefinitions`, `om-tool-coverage.ts` and `om-tools.test.ts`.
  - w22-conversion-settings (approved) shares `om-tools.ts`, `om-tool-coverage.ts`, `om-tools.test.ts` and `IntegrationsPage.tsx`.
  - Build this job after both. B1 must re-read those files first and add only its own hunks.
  - This job no longer needs w14-surface (CUTS 4–5).
- No contracts, package.json, lockfile, migration or dist changes are needed. The grant migration is already registered (`migrations.ts:33`).

LOCKS-FILES: features/measure/src/adapters/sql-grants.ts, features/measure/tests/sql-fixture.ts, features/measure/tests/contract/sql.test.ts, apps/server/src/composition/conversions.ts, apps/server/src/composition/catalog.ts, apps/server/src/om-tools.ts, apps/server/src/om-tool-coverage.ts, apps/server/tests/measurement-grants.test.ts, apps/server/tests/om-tools.test.ts, apps/studio/src/pages/addons/model/conversion-grants.hooks.ts, apps/studio/src/pages/addons/ui/ConversionGrants.tsx, apps/studio/src/pages/addons/ui/IntegrationsPage.tsx, apps/studio/tests/conversion-grants.test.ts, ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-grant-surfaces/progress.md, ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-grant-surfaces/report.md, ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-grant-surfaces/typecheck.txt (lock groups: w13-server-composition, w13-om-tools, w20-measure, w22-studio-pages)

## COORDINATOR OVERRIDE (open-marketing-f6)
1. Defaults accepted. W23-CONVERSION-PRODUCER-WORKER deferred (queued).
2. Whichever of this job and w22-conversion-settings builds second: re-read om-tools.ts, om-tool-coverage.ts, om-tools.test.ts and IntegrationsPage.tsx first and merge on top; never revert the other job.
