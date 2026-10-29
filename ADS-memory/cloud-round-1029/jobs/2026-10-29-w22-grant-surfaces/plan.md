Software Architect(Direct):

**1. Summary**

The owner will be able to list, grant and revoke conversion-sharing permission from Measure/Tracking, the assistant, HTTP and `om` CLI. Granting uses the existing exact Allow/Cancel card; visitor consent remains independently required at dispatch. Grant changes and their audit records commit together, and concurrent identical inserts return the stored grant. This run also prepares the SQL-backed worker binding; connecting it to boot requires the Coordinator handoff described below.

**2. Files**

All paths below are build locks; no other implementation files are authorized.

- `features/measure/src/adapters/sql-grants.ts` — (edit) bounded listing and conflict-safe insertion/read-back.
- `features/measure/src/adapters/verification.ts` — (edit) load one validated committed conversion by scoped subject/event identity.
- `features/measure/index.ts` — (edit) export the committed-event loader.
- `features/measure/tests/contract/port-suites.ts` — (edit) concurrent grant regression.
- `features/measure/tests/contract/sql.test.ts` — (edit) listing/loading assertions and competing-insert suite registration.
- `features/measure/tests/sql-fixture.ts` — (edit) controlled competing insert using the existing query fault-injection seam.
- `apps/server/src/composition/conversions.ts` — (new) audited grant operations and SQL-backed conversion worker composition.
- `apps/server/src/om-tools.ts` — (edit) three grant catalog definitions and their injected service binding.
- `apps/server/src/om-tool-coverage.ts` — (edit) grant coverage and Measure setup location.
- `apps/server/src/cli/index.ts` — (edit) help examples using existing generic tool commands.
- `apps/server/tests/om-tools.test.ts` — (edit) HTTP/tool/CLI approval and owner-authority regressions.
- `apps/server/tests/agent-plugin-jobs.test.ts` — (edit) real worker binding with SQL grants, inbox verification and fixture egress.
- `apps/studio/src/shared/api/validation.ts` — (edit) grant-page validation derived from canonical schemas.
- `apps/studio/src/shared/api/index.ts` — (edit) export that validator.
- `apps/studio/src/pages/tracking/model/measurement-grants.hooks.ts` — (new) grant form, listing and pending-operation state.
- `apps/studio/src/pages/tracking/ui/TrackingPage.tsx` — (edit) grant panel using existing `ApprovalCard`.
- `apps/studio/tests/tracking.test.ts` — (edit) grant/list/revoke presentation and unresolved-operation regressions.
- `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-grant-surfaces/progress.md` — (new) build checkpoints.
- `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-grant-surfaces/report.md` — (new) validation, counts and handoff.
- `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-grant-surfaces/typecheck.txt` — (edit) final typecheck evidence.

**3. Public contracts**

- Existing `createSqlMeasurementGrant(required, optional?)` retains `current/grant/revoke` and additionally returns:
  `list({ context: CallContext, query: PageQuery }, options?: CallOptions): Promise<Outcome<Page<MeasurementGrant>>>`.
  This extends the concrete adapter; no new port.
- `loadSqlConversion({ database, context: ServiceContext, subjectId, eventId }, options?): Promise<Outcome<ConversionInput>>`.
- `bindConversions({ database, identity, accounts, host, clock, ids, observer, runtimeMode, schedule })` returns `{ grants, worker }`; dependency and worker types derive from existing bindings.
- `grants.grant({ context, grant }, options?)` and `grants.revoke({ context, grantId }, options?)` return `Promise<Outcome<MeasurementGrant>>`; `grants.list` uses the listing signature above.
- Tools: `om_measure_grants_list({ limit, cursor? })`, `om_measure_grant(grantFields)`, `om_measure_revoke_grant({ grantId })`.
- `grantFields` derives from `measurementGrantSchema.omit({ scope: true, kind: true, revoked: true })`; the server supplies those omitted fields.
- HTTP uses existing `POST /api/tools/call`, operation lookup and approval-answer routes.
- CLI uses `om tools call <tool-name> --input-file <path|->`; no new command parser or transport.

**4. Approach**

1. Extend the SQL grant adapter with scope-qualified keyset listing, using `pageQuerySchema`, at most 100 results and one look-ahead row. Include revoked grants so the owner can see their state.
2. Compose owner grant/revoke operations with the existing SQL store and `MeasureAuditPort` on the **same transaction session**. Reject non-owner execution, scope mismatch and expired creation input. Validate account/connection ownership through the existing account lookup. Audit failure rolls back the authority change.
3. Register grant/revoke as existing `serviceDefinition` writes with `ownerOnly: true`. That already omits reusable operation scope and produces Allow/Cancel only. Agents may propose the operation; only the authenticated owner continuation executes it.
4. Reuse generic HTTP and CLI dispatch. Test that pending/cancelled requests persist no grant, broad choices fail, and confirmed requests record the actual owner context.
5. Add the panel to Measure/Tracking. Select an existing connection, derive destination from its plugin identity, and enter account, definitions, purpose and expiry. Keep generated IDs and fixed payload metadata out of the form. Render the server card; refresh the retained operation after answering before claiming success.
6. Build the worker binding through existing `host.conversions(...)`, which already constructs `createConversionDispatcher`. Supply SQL grant, verification, ledger and audit adapters; reuse identity identifiers and transaction-bound policy/lineage evidence. Reuse `withDeadline` for the bounded attempt.
7. The committed-event loader rejects missing, malformed or ambiguous rows. Because current worker payloads contain no grant ID, use existing `readBoundedPages` to find **one** current grant matching scope, destination, purpose, definition and payload. Missing, multiple or overflowed matches deny dispatch.
8. Preserve A3’s subject lane, lease fence, final consent/grant checks and plugin admission. Test grant revocation after enqueue, withdrawn consent, disabled plugin and local mode with zero fixture egress; test one successful production fixture attempt with one dispatch-start.
9. Fix the insert race with `INSERT … ON CONFLICT (scope_key, grant_id) DO NOTHING`, then read and compare canonical content. Preserve conflict and no-resurrection semantics. The SQL fixture inserts a competing winner immediately before the attempted insert, making the shared regression fail against today’s code.
10. Write tests without running them. Finish with one typecheck each for `@open-marketing/measure`, `@open-marketing/server` and `@open-marketing/studio`; one corrective rerun per package is allowed. No tests, builds or `om:check`.

**5. Reuse**

- Approval: `om-tools.ts`’s `serviceDefinition`, retained-operation lifecycle and `ownerOnly`; safety’s existing confirmation exchange and Studio’s `ApprovalCard`.
- Persistence/audit: `sql-grants.ts`, `sql-boundary.ts`, `sql-delivery.ts`, canonical `SqlSession` joining and `MeasureAuditPort`.
- SQL precedent: `features/workspaces/src/adapters/sql-store.ts` already uses conflict-safe insertion/read-back and scoped keyset listing. Extend measure’s existing adapter; add no generic SQL helper.
- Delivery: `agent-plugin-backends.ts`’s `conversions`, `workers.ts`’s `registerConversion`, `identity.forTransaction`, `readBoundedPages` and `withDeadline`.
- Searched Jini/Tovu for measurement grants, conversion sharing, approval and conflict-safe SQL. No matching measurement-grant implementation was found. Inspected Jini `CAPABILITIES.md`, installed `@jini-ai/core@0.6.15-rc.2/dist/gated-mutations*`, and Tovu’s taxonomy gated-mutation routes; introducing their separate ceremony would duplicate OM’s existing policy.
- Checked the [npm package page](https://www.npmjs.com/package/%40jini-ai/core) and attempted exact registry metadata; registry access failed and search results were stale. Installed rc.2 declarations remain the API evidence. No new dependency or OSS library is needed.

**6. Deliberately left out**

No new page, approval system, port, registry, retry loop, grant history table, per-conversion card or vendor-specific core code. No settings, identifier capture, attachments or delivery-diagnostics changes owned by other w22 jobs. Existing uncertain outcomes remain reconciliation-only; this job does not add retry classification or enable production ingress.

**7. NEEDS**

- **NEEDS — Coordinator composition:** the sole running `createFormWorkers` call is inside `bootServer` (`composition/index.ts:384`). Under the literal no-`bootServer`-edit rule, this job cannot connect the new binding. Coordinator integration must construct `bindConversions`, assign `services.measurementGrants = binding.grants`, and pass `conversions: binding.worker` to that call. These are assignments with zero added branches; production stays unbound until integration.
- **NEEDS — Coordinator locks:** serialize the listed shared tool, Studio and measure files with conversion-settings, consent-banner, diagnostics and Results jobs.
- **NEEDS — Coordinator artifacts:** confirm installed plugin bundles export `createConversionDelivery`; rebuild stale bundles under their existing integration ownership.
- Installs, shared-contract changes and new migrations: **none**. Existing grant migration is already registered.

**8. Unverified facts and risks**

- No vendor API behavior changes are proposed. A missing factory, invalid output, absent grant/consent or disabled plugin fails closed through existing boundaries.
- Multiple eligible accounts/grants cannot be selected safely from today’s worker payload; ambiguity denies delivery. Explicit grant/account binding in durable intent is **DEFERRED**, requiring a producer/worker contract job.
- Real Postgres concurrency will remain unexecuted here. The controlled competing-insert fixture verifies the losing-insert behavior without claiming a live Postgres result.
- **DISPUTED:** the old migration collision is fixed: `composition/migrations.ts:33` registers global v28 / measure local 5.
- Tests are written-only; this plan claims no red/green execution evidence.

**9. Size estimate**

One ≤90-minute build: roughly 20 files, 500–650 source LOC added, 250–350 test/fixture LOC added, and 15–35 lines removed; net approximately +715–985 LOC. Implement the owner surfaces and worker composition first, then the insert-race fix. If the major work consumes the timebox, defer the race fix explicitly and leave its files untouched.