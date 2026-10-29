# Opus 5.5 re-review — 2026-10-26 Codex fix wave (12 jobs)

Date 2026-10-26. 5 Opus 5.5 reviewers, read-only, judged against `2026-10-26-opus-review-wave.md`. Coordinator typecheck sweep of every touched package: 29/31 pass (`server` test file at agent-plugin-jobs.test.ts:222; `google-business-profile` missing `@jini-ai/mcp`). Nothing committed.

## Totals
~110 original findings checked: ~93 FIXED, ~16 PARTIAL, ~1 NOT FIXED, the rest DEFERRED (most justified). **All 4 original BLOCKERs fixed.** New: 0 BLOCKER, ~9 MAJOR, ~40 MINOR.

## Verdicts
| Fix job | Verdict |
|---|---|
| fx-contracts | small fixes |
| fx-server | ready after the 1-line test fix |
| fx-alerts | ready (inert; actual send waits on a server mail path) |
| fx-oe3-rerun | blocked again, changed nothing — owner decision A/B |
| fx-measure | small fixes |
| fx-messaging | small fixes |
| fx-plugins-c1 | small fixes (Meta completeness deferral not justified; Google date chunking) |
| fx-plugins-c2 | small fixes + Reddit daily metrics (deferral not justified) |
| fx-plugins-d1 | small fix run (X factory not justified to defer; Microsoft rows must go until it has a factory) |
| fx-plugins-d2 | small fixes (TikTok campaign-level metrics + status mapping) |
| fx-line-naver | small fixes + owner decision on LINE |
| fx-studio-content | small fixes (Meta limits + ad-copy pin deferrals not justified) |

## Remaining MAJORs (round 2)
1. **Plugin configuration contract** (R3): contracts leaves `configuration: unknown`; server sends the plugin.json extension + `{scope, connectionId, accountId, pluginDigest}`, each plugin parses its own strict shape → every real call `invalid_input`. Plugins also need account metadata the server doesn't supply (currency, timezone, country, clientLogin, customer IDs) (R4). Fix: one Zod configuration schema in contracts (common account fields + per-plugin `settings`), server passes exactly that, plus one test that loads a REAL plugin factory.
2. **Server drops a whole plugin** on a reserved catalog ID (`agent-plugin-backends.ts:139`, GBP `organic.publish.v1`) or a missing `createCapabilities` (:143, Microsoft/X) (R1, R3, R4). Fix: skip reserved IDs; X gets its factory (~20 lines); Microsoft's canonical rows removed until its developer-token path fits the ABI.
3. **Twilio reads fail once authToken is saved** — strict read parser rejects the new card field (R2); WhatsApp same, pre-existing.
4. **Resend manifest test fails** — `@jini-ai/platform` not declared (R2).
5. **TikTok** metrics account-level only; campaign status maps only DISABLE → batches never complete (R4).
6. **Google** 1,000-row cap → incomplete for ~12 campaigns × 90 days; chunk the date range (R3).
7. **Amazon** credential card withdrawn but `integration-credential-cards.test.ts` still expects one; GBP missing from that list (R3).

## Coordinator / integrator items
- `apps/server/tests/agent-plugin-jobs.test.ts:222` add `read` to the ledger test double (cause: last night's w2-offline-conv).
- GBP `@jini-ai/mcp`: root devDependency + lockfile importer, frozen offline install; drop `runCli` re-export from GBP `src/index.ts`.
- Charts: add both to pnpm-workspace.yaml, lockfile importers (echarts/zrender 6.1.0, tslib 2.3.0, chart.js 4.6.1, @kurkle/color), frozen install, typecheck, `build:artifact` (integrity map). Not seeded/packaged anywhere — owner: bundle or upload-only?
- `bundled-skill-content.test.ts` belongs in apps/server/tests.
- Ruling: messaging plugins' server-supplied consent `authority` callback STAYS (dispatch-time recheck required by COMMON.md §10; not a per-plugin approval gate); plugin-local `admitted` checks that duplicate the invoker go.

## Owner decisions
1. oe3: **A** feature slice becomes the one lifecycle (as designed; needs lane + small manifest change) or **B** delete the unused feature lifecycle, keep the server's.
2. LINE: Japan delivery ends 2026-10-26, API retires March 2027; OM deploys TW/TH only. Make status work for TW/TH, or park LINE.
3. Chart plugins: bundled like Recharts, or upload-only.

Detailed per-job ledgers follow.

## R1 — Server and contracts

### fx-contracts — verdict: small fixes
Ledger (w-p1-invoker, w-oe5-schemas, cross-cutting "Plugin host interface" + rule-of-two helpers):
- MAJOR invoker reads `bindings` key — FIXED. agent-plugin-backends.ts:130-152 parses canonical rows out of the existing `capabilities` array with `capabilityEnvelopeSchema`; addons.ts:151-156 passes `capabilities.capabilities` through. No `bindings`/`capabilityBindingSchema` left.
- MAJOR ABI mismatch — FIXED on the host side. contracts/capabilities/index.ts:70-86 defines `PluginCapabilityDependencies` {fetch, credentials, clock, observer, wait, configuration}, `PluginCapabilities` (catalog-keyed) and `PluginCapabilitiesFactory`. There is no deadline port: cancellation arrives through `CallOptions.signal`, and the host enforces a 30s deadline itself (agent-plugin-backends.ts:174-192). There are no authority or admission ports. This is the single minimal shape ctx-fix-1026 decided on. The invoker calls `handlers[capabilityId]` with exactly these deps (:205-211).
- MAJOR unbuilt plugins appear as fake write tools — FIXED (:531 `!loaded.entryUrl` returns `[]`).
- MINOR campaignPluginId loads every plugin — FIXED (:119-125 derives the ID from the frozen tool name, then checks that one plugin).
- MINOR addons `state()` cost — PARTIAL. Now 1× `repo.list` (the catalog row is reused) plus 1× `listInstalledPlugins` per call, down from 2×. It still runs once per guarded fetch. This is a performance issue only, so it is acceptable.
- OVERENG duplicate binding schema / `admitted` — FIXED. The remaining `capability.admitted` is the contracts envelope field, so the plugin can only restrict itself.
- RULE vendor switches still hard-coded — NOT FIXED. The review accepted this as a staged migration, so no action is needed.
- Test quality (fixture built on the invoker's own ABI) — PARTIAL. agent-plugin-backends.test.ts:861-891 uses the real TikTok capabilities.json rows, but with an inert factory, not the real plugin's `createCapabilities`. The checked-in dists (built Oct 14) predate the ABI, so a real-dist case would fail until the plugins are rebuilt. Acceptable for now; add a real-dist case after the rebuild.
- RULE oe5 forwarding re-exports — FIXED. integration-oauth-contracts.ts and studio validation.ts now import from `@open-marketing/contracts`. What remains in those files are real server/browser refinements, not re-exports.
- MINOR media-library quote style — FIXED.
- Rule-of-two helpers — FIXED for the three the job named: `decimalToMicros` (BigInt, half-even, exponent-aware, metrics/index.ts:13-35), `serviceContextSchema` (with the `ServiceContext` type derived via `z.infer`, values/index.ts:22-24) and `parseExactIntegerJson` (values/index.ts:42-78; Node 24.2 supplies the reviver `context.source`). It also keeps safe integers such as `1.0` and negatives, which fixes the X reviver MINOR in passing. 9 plugins import it.
- One-approval rule — HOLDS. `invokeCapability` refuses any non-read tool (:166). Reads still go through `bindingCurrent` and `invocationAllowed`. Effectful canonical capabilities use the generic card/dispatch path (test :1017). Effects stay unioned with the catalog floor.

New:
- [MAJOR] apps/server/src/composition/agent-plugin-backends.ts:139 — a canonical row for a *reserved* catalog ID (`organic.publish.v1`, `campaign.deploy`, `brand.extract.v1`, `campaign.validate.v1`) throws "Duplicate or reserved capability". Failure: google-business-profile's capabilities.json declares `organic.publish.v1`. As soon as GBP has a dist and is enabled, `pluginDefinitions`' catch replaces the whole plugin, including its `report.metrics.v1`, with one `vendor_google_business_profile_unavailable` **write** descriptor. Fix: treat reserved IDs like legacy rows, `if (!capabilityCatalog[id.data].input) return [];`, and throw only on duplicates.
- [MINOR] agent-plugin-backends.ts:143 — a missing `createCapabilities` export also throws for the whole plugin. Failure: microsoft-ads and x-ads declare `report.metrics.v1`/`campaign.status.v1` rows but still export no `createCapabilities` (grep of their src). Once built, they lose every tool. Stale dists of google/meta/linkedin/tiktok behave the same until rebuilt. Fix: mark only the capability contributions unavailable when the factory is absent, and keep the plugin's other tools.
- [MINOR] packages/contracts/src/values/index.ts:75 — an integer-valued number above 2^53 whose source is in exponent form (e.g. `1e21`) throws, and the whole document becomes `protocol_mismatch`. This is acceptable as fail-closed; just note it.

Disputes/deferrals: none claimed. "Plugin adoption is for later jobs" is correct per the job text. Leaving out zonedMidnight and checkCapabilityCall is within scope (the job named three helpers).

Typecheck: contracts ok, studio ok, media-library ok. Server failure: see the shared item below. This job's lane explicitly included `apps/server/tests/agent-plugin-jobs.test.ts`, and the job edited that file (+addons/entryUrl), but it left the broken double and reported it as FX-server's.

### fx-server — verdict: ready to commit (after the one-line test double fix below)
Ledger:
- BLOCKER identity.ts:75 `observedCampaigns` — FIXED with the fail-closed `[]` adapter (identity.ts:76). The real reporting-backed source is still a NEED, and that is acceptable.
- BLOCKER strict `landingSchema` / `collectionAuthority` — FIXED. public.ts:18-20 reuses `landingPropertiesSchema` (+fbc/fbp for compatibility). identity.ts:78 allows `utm_source/utm_medium/om_a/utm_id/pageUrl`. Ingress forwards only those keys plus linkId/campaignId; click IDs are still dropped. Regression covered at ingress-worker.test.ts:189,236.
- MAJOR campaignClaim drops link-resolved OM IDs — FIXED. rules.ts:52-54 keeps a non-ck1 opaque campaignId when a linkId is present (ingress overwrites it with the link's campaign, so it cannot be forged). service.ts:101-105 projects it without observation.
- MINOR non-paid/incomplete macros discard a valid ck1 — FIXED (rules.ts:55-57 fall back to the canonical claim).
- MINOR replayDigest semantics change — FIXED (documented in B1 RISKS).
- MINOR snippet consent/activation — PARTIAL. Tag activation no longer depends on the collection fetch. Late consent is deferred, which is OK because no host consent source exists.
- MINOR `lastHeartbeat` json_extract scan — DEFERRED-OK. It is performance only and the readiness surface is not wired. It needs a new web-events migration (v27).
- MINOR readiness spoofable via pageUrl — PARTIAL. public.ts:126-131 keeps pageUrl only when its origin equals the request `Origin` header. Transport already pins Origin to OM's host, so this binds readiness to OM-hosted pages. A non-browser client can still set the header. Acceptable while readiness has no surface.
- MAJOR migration ordering — FIXED. migrations.ts:28-31 registers v23 leads/1, v24 server/6, v25 measure/3 and v26 brand/1, ascending, in one change. boot.test.ts:128-136 asserts the tail and all new tables (v24 later gained `server_alert_email_reservation` from fx-alerts; it never shipped, so that is fine). Desktop packaging globs `features/*/migrations/*.sql`, so the new files ship.
- MINOR appendJobEvidence post-commit expiry — FIXED (jobs/src/sql.ts:50-87: expiry is checked inside the transaction only).
- RULE appendJobEvidence complexity — FIXED (`validateDispatchEvidence` extracted).
- MINOR campaigns.ts:75 redundant check — FIXED (campaigns.ts:72-74).
- Test quality dedup/digest — FIXED by inspection: jobs/tests/contract/store-suite.ts:13 covers concurrent dedup and digest conflict for memory and SQL.
- Integrator package registration — FIXED. skeleton.test.ts: count 18, plus leads/brand file and suite mappings that match the files on disk.
- Credential-card list — FIXED (integration-credential-cards.test.ts:148-151 lists all 16 new IDs).

New:
- [MINOR] features/web-events/src/rules.ts:53 — a direct `?campaignId=<OM id>` landing with no linkId is no longer attributed. At HEAD it was stored, and public.ts:117-121 still spends a `campaigns.get` lookup on it and returns 403 if it is unknown. The landing is then stored with `campaignId=null`. No OM generator emits bare campaignId today (measure links use linkId), so the impact is low. Fix: either accept a scope-verified OM ID without linkId (ingress already verifies it), or stop forwarding/looking it up in ingress.

Disputes/deferrals: the heartbeat-index and late-consent deferrals are justified (above). Lane note: the shared agent-plugin-jobs.test.ts double was also inside this job's lane (`apps/server/tests/`). Its B1 wrongly calls the file "outside this run's approved file list".

Typecheck: web-events ok, jobs ok, server fails only on the shared item below.

### fx-alerts — verdict: ready to commit (inert; email binding remains a NEED)
Ledger:
- MINOR→MAJOR feed ordered by random UUID — FIXED. alerts/store.ts:43-64 pages by `(created_at, notice_id)` with a canonical base64url composite cursor and the matching index in 0006_alerts.sql. Regressions at alerts-jobs.test.ts:206,231. The feed is oldest-first. That is fine, but the Studio feed will probably want newest-first, so flag it for whoever wires the surface.
- MINOR lifetime rule ignores flightEnd — FIXED (alerts/rules.ts:72 `now >= flightEnd`).
- MINOR private retryPolicy — FIXED (alerts/jobs.ts:36 uses `formRetryPolicy`).
- RULE loose modules — FIXED (apps/server/src/alerts/{rules,store,jobs,email,index}.ts; the old top-level files are gone).
- NEED `alerts.evaluate` in worker jobSchema — FIXED. workers.ts:23-25 has the schema and identity check (:38-43), plus an optional registration (:82-92) with transient/permanent mapping. It is not passed from composition/index.ts, so boot enqueue and sources stay deferred, as the job allowed.
- Owner email (unfinished work) — DEFERRED-OK for the send itself. What was built: email.ts `enqueueAlertEmail`, which puts one `alerts.email` job per scoped notice into the outbox, binding noticeId plus definitionDigest. It also built `reserveAlertEmail`, a durable append-only reservation: at most 20 per owner per UTC day, once per notice, never refunded. The deferral is genuine. The server has no mail path (no mail/Resend code in apps/server; resend-email has no dist; `invokeCapability` is read-only; the catalog has no mail capability; and contracts' only grant is `MeasurementGrant`). Sending would need a new mail binding and grant type, which the job said to report as a NEED rather than build.

New:
- [MINOR] apps/server/src/alerts/email.ts:37 + composition/workers.ts:25 — `enqueueAlertEmail` writes handler `alerts.email`, but the closed worker `jobSchema` has no such handler. Failure: if anything calls it before the binding exists, the worker's `decode` throws, `authorize` returns not-allowed and the job is refused. Nothing calls it today. Fix: leave enqueue uncalled (documented), or drop it until the sender exists.
- [OVERENG, MINOR] email.ts + `server_alert_email_reservation` + 4 tests (~150 lines) have no caller and no consumer. The brief asked for them, so keep them, but they are speculative until the sender lands. The cap uses UTC days, not the owner's timezone (documented in B1).

Disputes/deferrals: none disputed. Boot enqueue, sources and HTTP/CLI/MCP/Studio are deferred per the job text, which is OK.

Typecheck: server source ok; test failure is the shared item.

### fx-oe3-rerun — verdict: another fix run (after integrator unblock; nothing changed)
Ledger (oe3 audit findings 1, 2, 12):
- Finding 1 (plugins lifecycle stack) — DEFERRED. The block is real (see below).
- Finding 2 (federation host) — DEFERRED. The block is real: the running federation workflow lives in apps/server/src/composition/addon-federation.ts (307 lines), which is outside the lane.
- Finding 12 (om-tools fake-HTTP reads) — DEFERRED-NOT-OK. om-tools.ts *was* in the lane and the cleanup needs no integrator work. It was skipped only because the plan bundled it with federation.
- stage=done / B1.status=ok while B1 says "blocked; no behavior changed". This is the same false "done" the original review flagged.

What it claims to need, and whether it is real:
1. "Assign ownership of `apps/server/src/addons.ts`" — REAL. The running lifecycle (`createAddons`, performInstall/SetEnabled/Uninstall, 208 lines) lives in apps/server/src/addons.ts. The lane override covered composition/addons.ts, a different file. Consolidating behind features/plugins means editing addons.ts.
2. "Add `@open-marketing/plugins: workspace:*` to the server manifest + lockfile importer" — REAL. apps/server/package.json:35-51 lists federation but not plugins, and no app imports `@open-marketing/plugins`. Server code can't import the feature without the dependency, and the lockfile is integrator-only (frozen-lockfile rule).

Smallest unblock (pick one):
- A (as designed): the Coordinator adds `apps/server/src/addons.ts` and `apps/server/src/composition/addon-federation.ts` to the lane. The integrator adds `"@open-marketing/plugins": "workspace:*"` to apps/server/package.json, adds the `'@open-marketing/plugins': {specifier: workspace:*, version: link:../../features/plugins}` entry to the `apps/server` importer in pnpm-lock.yaml, and runs `pnpm install --offline --frozen-lockfile`. That is about 4 lines; then re-run oe3 B1 from the existing plan.
- B (cheaper, no integrator work): the features/plugins orchestration is unconstructed dead code (service.ts, jini-adapter.ts, trust-adapter.ts, filesystem-repo.ts and their tests). Delete it inside features/plugins/, keep the package inspection, and leave server `createAddons` as the one runtime. That fits the owner's "slices only for durable state + policy" rule and is net-negative. Do finding 12 in om-tools.ts in the same run. Federation would follow the same pattern. Owner decision: A vs B.

Typecheck: plugins ok, federation ok; server fails only on the shared item.

### Shared typecheck failure (all four jobs report it)
`apps/server/tests/agent-plugin-jobs.test.ts(222,9) TS2741: 'read' missing in ConversionDeliveryStatePort`.
- Cause: last night's **w2-offline-conv** added the required `read` to `ConversionDeliveryStatePort` (features/measure/src/ports.ts:69-75; its B1 line 22: "required `ConversionDeliveryStatePort.read`"). The original review checked implementers but missed this inline test double. The failure was hidden until today because identity.ts:75 broke the server *source* typecheck first. None of today's jobs caused it. FX-contracts (whose lane named this file and which edited it) and FX-server (lane `apps/server/tests/`) could each have fixed it, but both labelled it out-of-lane.
- Smallest fix, at agent-plugin-jobs.test.ts:222: `ledger: { read: input => ledger.read(input), async begin(input) {…}, async append(input) {…} },` (`ledger` is the memory state created at :177, which implements `read`).

### Cross-job checks in R1
- Server it.each covers all 21 carded plugins (FIXED). One copied card test remains: content/agent-plugins/apple-search-ads/io.github.ainsep.openmarketing/tests/manifests.test.ts still contains "declares identity-bound credential fields" (plugin-lane job).
- No plugin factory is exposed to authority/admission ports through the host ABI. microsoft-ads and x-ads still lack `createCapabilities` (plugin-lane job; see the fx-contracts MINOR).
## R2 — Measure and messaging

### fx-measure — verdict: small fixes

Ledger (w2-p1-reporting):
- MAJOR: no reporting→delivery/policy boundary rule — FIXED. `development/scripts/boundaries.mjs:96-119` `reportingBoundaryViolations` walks the resolved repo-relative edge graph transitively from every `features/measure/src/reporting/*` origin. It rejects reaching `features/measure/src/{delivery,ingestion}/` or `features/policy/`. `fileEdges` records type-only imports, re-exports and workspace-package edges (`@open-marketing/policy` resolves to `features/policy/index.ts`), so the rule has real reach. It is wired into `checkBoundaries` (:175). The untangle is real: `delivery/diagnostics.ts` is gone, the diagnostics schemas moved to `src/types.ts:5-21`, and `rules.ts`, `types.ts` and `ports.ts` no longer import anything under `delivery/`. Current reporting files reach only rules/types/ports/contracts, so the rule passes today and fails if any of them later pulls in delivery. The test is `features/measure/tests/reporting-boundary.test.mjs`; vitest's default include picks up `.mjs`.
- MINOR: `COLLATE BINARY` — FIXED (`sql-metrics.ts:52`, plain ORDER BY). Nit: syncIds are restricted to `[\x21-\x7e]` (`metrics.ts:9`), but Postgres with a non-C locale still orders punctuation and case differently from SQLite, so the tie-break order can differ. It matters only when `retrieved_at` ties. Use `COLLATE "C"` when the Postgres adapter lands.
- MINOR: whole batch re-parsed for every day — FIXED (`sql-metrics.ts:76-83`, call-local cache keyed by sync_id).
- OVERENG: UTF-8 tie-break — FIXED (replaced by an ASCII syncId regex). Mapping copied into every observation — FIXED (moved to result level, `campaign-results.ts:13,45`).

Ledger (w2-offline-conv):
- MAJOR: stage-occurrence eventId lets a re-qualified lead send twice — FIXED. `service.ts:29-36` `ingestLeadOutcome` derives `eventId = leadId + ":" + definitionId`. The input schema (`delivery/input.ts:15`) omits a caller-supplied eventId and allows only `qualified`/`won`. The repo deduplicates by (scope, sourceId, eventId) and returns `conflict` on changed evidence (memory-repo.ts:46-48,107; sql-repo.ts:63-76). After qualified→disqualified→qualified, the second ingest therefore returns `duplicate` (same evidence) or `conflict` (new occurredAt or value), and no second job is enqueued. Retraction is documented as "not sent" (`types.ts:70-72`, input.ts:8-10). Memory and SQL tests cover this, including rollback (`tests/ingestion.test.ts:8-54,126-136`).
- MINOR: diagnostics have no producer — DEFERRED-OK (vendor mappings are an integrator NEEDS). The regression guard was added (`ledger-rules.ts:17-21`, and an append without diagnostics keeps the prior ones) — FIXED, but see New below.
- MINOR: caller-owned port from leads — FIXED. The leads-facing sink is `Pick<MeasureService,"ingestLeadOutcome">`. Leads wiring is out of lane (correctly).

New:
- [MINOR] `features/measure/src/service.ts:23` vs `:29` — the dedup holds only if every lead outcome comes through `ingestLeadOutcome` under a single stable `sourceId`. Failure: `ingestConversion` still accepts `definitionId:"qualified"` with any caller eventId. A second source (for example a form webhook and a CRM import, each with its own sourceId) produces a different `conversionKey` (rules.ts:59-61), so a second conversion is sent. HANDOFF.md:240-242 notes the sourceId requirement only in prose. Fix: make `ingestConversion` reject `qualified`/`won`, or key lead outcomes by (scope, eventId) without sourceId.
- [MINOR/RULE] `features/measure/src/types.ts:74-77` — the `ingestLeadOutcome` input type is hand-written (`event: Omit<ConversionInput,"eventId">`, definitionId: string) instead of being derived from `leadOutcomeInputSchema`. Callers type-check `definitionId:"spam"`, which fails only at runtime. In addition, the exported `leadOutcomeConversionSchema`/`LeadOutcomeConversion` (index.ts:12-13, input.ts:11) still includes `eventId`, which contradicts "intake owns the event ID". Fix: `z.input<typeof leadOutcomeInputSchema>`, and export only the input schema.
- [MINOR] `features/measure/src/delivery/ledger-rules.ts:19-20` together with `dispatcher.ts:131` — a diagnostics "regression" (`processed` true→false, or an older `observedAt` caused by vendor clock skew) fails the whole append with `conflict`. Failure: a delivery that the vendor confirmed `delivered` never gets its status recorded, and stays dispatching/unknown on every reconcile. Fix: merge monotonically (keep the confirmed `true` and the newer observedAt) instead of rejecting the append.
- [MINOR] `features/measure/HANDOFF.md:176,181,183` — stale lines still say the boundary rule is "integrator NEEDS" and that "reporting reaches delivery via rules.ts". Both are now false. Delete them.
- [MINOR, pre-existing, from last night] `ConversionDeliveryStatePort.read` (`ports.ts:69-72`) has no production consumer (grep shows no `ledger.read(`), yet it is required on every implementer. It is also the cause of the server typecheck failure below. Consider making it optional, or dropping it until the diagnostics display lands.

Disputes/deferrals: B1 has no disputes. Its NEEDS (leads wiring with earliest evidence, vendor qualified/won mappings, grants, diagnostics producers, v25/outbox/cohort wiring) are all out of lane, so the deferrals are justified.

Typecheck: `@open-marketing/measure` exit 0. `@open-marketing/server` fails at `tests/agent-plugin-jobs.test.ts(222,9)` TS2741: `read` is missing on the `ledger` wrapper. Cause: w2-offline-conv (last night, still uncommitted) made `read` required on `ConversionDeliveryStatePort`, and the wrapper at :222 implements only `begin`/`append`. The original review missed this implementer. fx-measure did not cause it, and apps/server was outside its lane. Smallest fix (server lane): add `read(input) { return ledger.read(input); },` to the object at agent-plugin-jobs.test.ts:222.

### fx-messaging — verdict: small fixes

Ledger (w-messaging-r2):
- BLOCKER: Twilio `import twilio` — FIXED. `twilio-sms/.../src/webhooks.ts:1,49-54` uses `node:crypto`. The signed string is the exact configured URL followed by the form keys, sorted case-sensitively, with name+value concatenated without delimiters. It is HMAC-SHA1 keyed by the Auth Token, base64-encoded, and checked for exact format (28 chars) before `timingSafeEqual`. This matches Twilio's documented algorithm, including keeping the port for SMS-over-HTTPS (verified at twilio.com/docs/usage/security). Repeated keys are rejected rather than dropped. The package has no `twilio` dependency, no import remains anywhere, and NOTICE is back to HEAD. `tests/webhooks.test.ts:8-15` builds the signature independently.
- MAJOR: SES refuses X-Original-To — FIXED. `amazon-ses/.../src/mail.ts:91-98` now blocks reserved MIME headers instead of allowlisting. Jini `policy.js:100` adds `X-Original-To`, and `tests/mail.test.ts:217` covers it.
- MAJOR: SNS static PEM map — FIXED. `mail.ts:220-261` validates the TopicArn and the exact `https://sns.<region>.amazonaws.com/SimpleNotificationService-*.pem` origin and path (no query, hash or userinfo) before any I/O. It fetches with `redirect:"error"` under a 10s deadline, caps the PEM at 16 KiB, checks validFrom/validTo, caches one certificate for at most 1h, and replaces it on URL rotation. Verification uses SHA1 for SignatureVersion 1 and SHA256 for 2, with AWS's canonical Notification field order, including the optional Subject. This matches the AWS SNS docs. Remaining user-ease gap: SubscriptionConfirmation is still manual (`mail.ts:26`, README:24). This was deliberately scoped out in plan.md:82 — DEFERRED-OK.
- MAJOR: consent recheck exists only as a docstring for Resend/SES — FIXED in code. Both factories require an `authority` callback (`resend mail.ts:28,35,106-114`; `ses mail.ts:42-43,130-137`). HTTP runs only inside `execute`, at most once, on a frozen input. Tests: resend mail.test.ts:147-185, ses :150-188. The server-side subject-lane wrapper is still an integrator NEEDS.
- MAJOR: WhatsApp exact-"STOP"-only opt-out — FIXED for the scope of the brief. `whatsapp-business/.../src/webhooks.ts:78-82` checks `button.text`/`button.payload` for `type:"button"` and text bodies, normalized for case, punctuation and whitespace, against STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT/REVOKE/OPTOUT/STOPPROMOTIONS. Gaps are listed under New.
- MAJOR: Twilio card dropped `authToken` — FIXED (`twilio-sms/plugin.json` secretFields include an optional `authToken`). See the New MAJOR on the credential parser.
- MAJOR: Resend card cannot hold the webhook secret, and requires a separate sending key — FIXED. It is now `app-credentials` with `token` (Full access) plus an optional `webhookSecret`, and the separate-key requirement is gone. It passes `cardSchema` (no `fields` needed; the api-key single-field rule does not apply).
- MINOR: email 429 not retryable — FIXED (`rateLimited` with Retry-After clamped to one day, in both providers).
- MINOR: Twilio/WhatsApp 4xx always `forbidden` — FIXED (twilio broadcast.ts:89; whatsapp :87-91 handles HTTP 429 plus Meta codes 130429/131056).
- MINOR: WhatsApp `wa_id` match — FIXED (`contacts[0].input`, broadcast.ts:97).
- MINOR: strict status enum / `field` literal — FIXED (webhooks.ts:24-26,61,70 skip unknown fields and statuses; test :71).
- MINOR: Twilio single-sender vs service pool — FIXED (webhooks.ts:65-69 accept a matching MessagingServiceSid).
- MINOR: mailto+https List-Unsubscribe refused — FIXED (both providers' `validUnsubscribe`).
- OVERENG: duplicate `readBody` / WhatsApp `configurationSchema` — FIXED (exported from transport.ts and reused).
- JINI: bounded reader — interim reuse done; wait for 0.6.15 — DEFERRED-OK.
- RULE: positional `eventsFor(value)` — FIXED (`eventsFor({ value })`).
- MINOR test: fixture authority proves only the callback — DEFERRED-OK (needs server barrier tests).
- Typecheck not run on all four — FIXED (Coordinator run: all four exit 0).

Ledger (w-vendor-cards-r2, messaging items):
- Copied card tests — PARTIAL. The ~24-line copies are gone from all four, and the server `it.each` (integration-credential-cards.test.ts:148-151) covers amazon-ses, resend-email, twilio-sms and whatsapp-business. But the job added a new card-shape test, `resend-email/.../tests/manifests.test.ts:22-29`, and kept card `toMatchObject` checks at :11,:19 and `amazon-ses/.../tests/manifests.test.ts:13,27-31`. These are the same kind of copy the shared decision said to delete. Fix: delete them (the server real-parser test covers the cards).
- Twilio `authToken` card — FIXED.
- Card intro jargon (resend/twilio/ses) — FIXED. No "server vault", "host-pinned" or "separately resolved" text remains, and the intros now say what the owner enters. The WhatsApp token card intro is still jargon-heavy ("The optional appSecret signs raw webhooks…"), but it was not assigned.

New:
- [MAJOR] `twilio-sms/.../src/transport.ts:8` — `credentialSchema` is a `z.strictObject({accountSid, apiKeySid, apiKeySecret, expiresAt?})`. The card now also saves `authToken`, and the server stores app-credentials as "exact JSON of declared public/password fields" (apps/server/src/integration-credential-cards.ts:4). Failure: once the owner adds the Auth Token, as the card intro tells them to, every Twilio read fails `unauthenticated`. Fix: add `authToken: z.string().min(1).max(4096).optional()` to the read credential schema, or have the broker strip it. The same latent mismatch exists in WhatsApp: `transport.ts:9` is strict `{accessToken, expiresAt}`, but the card saves `wabaId`, `phoneNumberId` and `appSecret` too. That one predates this job and was not assigned; it needs the same fix. broadcast.ts:30/:20 use non-strict `z.object` with different maxima, so the read and send parsers disagree.
- [MAJOR] `resend-email/.../tests/manifests.test.ts:14` asserts `pkg.dependencies["@jini-ai/platform"] === "0.6.12"`, but `resend-email/package.json:10` lacks that dependency (SES has it). Failure: deterministic red test. The fixtures import Jini at runtime, so they also resolve only through the root hoist. Fix: add `"@jini-ai/platform": "0.6.12"` to resend-email/package.json. It is in lane, and plugins are not pnpm workspace members, so the lockfile is untouched. Otherwise revert the assertion.
- [MINOR] `whatsapp-business/.../src/webhooks.ts:61` — only `field === "messages"` is projected. Per Meta's `user_preferences` webhook docs, a user who stops marketing from WhatsApp's own UI sends `field:"user_preferences"` with `category:"marketing_messages", value:"stop"`, and no button or text message. Failure: OM never records the withdrawal. Meta still blocks delivery, so the effect is wrong OM consent state plus wasted, failing sends, not a compliance leak. The keyword list is also English-only: a localized opt-out button ("Detener promociones") is missed unless its payload matches. Fix: project `user_preferences` stop events. Meta documents that `wa_id` may differ from the phone number, so resolve by wa_id.
- [MINOR] `twilio-sms/.../src/webhooks.ts:17` — `MessageSid` must match `^SM…`. Failure: an inbound MMS STOP (a picture plus "STOP", MessageSid `MM…`) fails the parse and returns `invalid_input`, so the opt-out is lost. Fix: accept `^(SM|MM)[0-9a-fA-F]{32}$` for inbound.
- [MINOR] `resend-email/.../src/mail.ts:65-73` — unlike SES, Resend's `validHeaders` does not block reserved headers. Failure: a composed message that carries `Bcc`/`To`/`From` in `headers` reaches Resend after `authority` approved a single recipient. Fix: reuse SES's reserved-header regex (mail.ts:94).
- [MINOR/RULE, needs a Coordinator ruling] The shared decision says "Plugins get NO authority/approval/admission ports". The messaging plugins take an `authority` callback (mandated by this job's brief, so it is a defensible exception: it is the server's consent/subject-lane recheck at egress, not a per-plugin approval). They also self-check `configuration.admitted` (twilio broadcast.ts:42, whatsapp broadcast.ts:41). Record the exception in ctx-fix, or rename the callback to make clear it is the server invoker's lane hook.
- [OVERENG, low] `format`, `freezeInput`, `validUnsubscribe` and `rateLimited` are byte-identical in resend and SES mail.ts (~45 lines). Rule-of-two applies. Candidate: upstream to Jini mail (reusable header/Retry-After helpers) or move to contracts helpers.

Disputes/deferrals:
- "Current Meta v26 docs inaccessible": partly valid (Meta's developer pages often block fetches), but a web search finds Meta's `user_preferences` webhook reference immediately. The missing coverage above is therefore a skip, not a blockage. The button/contacts.input claims were verified from archived SDK types — acceptable.
- Automatic SNS subscription confirmation, extra AWS partitions and arbitrary-language intents were scoped out (plan.md:82). The first is OK for now and the second is OK. The third is the localized-button MINOR above.
- "Email typecheck unverified" — superseded: the Coordinator run shows resend-email and amazon-ses at exit 0.

Typecheck: twilio-sms, whatsapp-business, resend-email and amazon-ses all exit 0. No failures in this lane. The red test above is a runtime assertion, not a type error.

Sources checked: Twilio webhook security (twilio.com/docs/usage/security; twilio.com/docs/usage/webhooks/webhooks-security), AWS SNS signature verification (docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message-verify-message-signature.html; aws.amazon.com/blogs/security/sign-amazon-sns-messages-with-sha256-hashing-for-http-subscriptions), Meta user_preferences webhook (developers.facebook.com/docs/whatsapp/cloud-api/webhooks/user_preferences).
## R3 — Ad plugins C

Paths are relative to `content/agent-plugins/`. `E` = `io.github.ainsep.openmarketing`. Everything below was checked against the working tree, not against the jobs' B1 reports. Vendor behaviour was checked on the web on 2026-10-26.

### Cross-job finding (affects both jobs, and every plugin)
- [MAJOR] No plugin's `createCapabilities` can accept the `configuration` the server actually sends.
  - **What the server passes:** `apps/server/src/composition/agent-plugin-backends.ts:208-209` passes `configuration: { ...state.metadata, scope, connectionId, accountId, pluginDigest }`. Here `state.metadata` is the whole plugin.json OM extension (`version, enabled, admitted, credentialCards, credentialAssets, servers, capabilities`), per `apps/server/src/composition/addons.ts:150,156`.
  - **What each plugin parses:** every plugin uses a strict schema with a different shape:
    - google-ads `E/src/read-capabilities.ts:14`: `{binding}`;
    - meta-ads `E/src/read-capabilities.ts:14`: `{binding}`;
    - GBP `E/src/plugin.ts:27`: `{binding}`;
    - amazon `E/src/transport.ts:13`: flat `{scope, connectionId, accountId, region}`;
    - pinterest `:13`: flat, plus `currency, apiVersion, pluginDigest, bindingId`;
    - reddit `:10`: flat, plus `currency`;
    - snapchat `:11`: flat, plus `currency, timezone, apiVersion, pluginDigest`.
  - **Failure:** strictObject rejects the extra metadata keys, and the plugin-specific keys (binding, currency, timezone, region) have no server source. So every real invocation returns `invalid_input` before any I/O. Server tests never catch this, because they use inline fake factories (`apps/server/tests/agent-plugin-backends.test.ts:868-878`) and never load a real plugin factory.
  - **Root cause:** the contracts ABI leaves `configuration: unknown` (`packages/contracts/src/capabilities/index.ts:80`).
  - **Fix (integrator, contracts + server):**
    1. Define one Zod `pluginConfigurationSchema` in contracts: `{scope, connectionId, accountId, pluginDigest, settings: record}`, where `settings` is per-connection data such as currency, timezone, region and customerId.
    2. Have the server pass exactly that shape, not the spread manifest.
    3. Have each plugin parse `pluginConfigurationSchema.extend({settings: <own schema>})`.
    4. Add one server test that loads a real plugin's `createCapabilities`.

### fx-plugins-c1 — verdict: small fixes (plus the integrator ABI item above)
Ledger (w-p1-metrics-google-meta):
- Google conversion decimals: **FIXED.**
  - The reader keeps the source text: `google-ads/E/src/transport.ts:131` passes `numericTextKeys:["conversions","conversionsValue"]`.
  - `metrics.ts:54-59` then rounds half-even through contracts `decimalToMicros`.
  - The mapping meaning documents the rounding (`:12-13`).
  - Regressions exist at `tests/read-capabilities.test.ts:157,174-177`, including `0.3333333333333333 → "333333"`.
- Google 1 MiB / no pagination: **PARTIAL.** The result is now truthful but still small.
  - The query uses `LIMIT 1001` (`metrics.ts:29`) and a sentinel row. Over 1,000 rows gives `complete:false`, `freshness:"stale"`, `dataThrough:0` (`:43,77-78`). The test uses realistic `resourceName` rows (`tests/read-capabilities.test.ts:179-190`).
  - The job brief allowed a truthful partial result. In practice, though, 12 campaigns × 90 days (1,080 rows) can never be complete, so the reconciliation gate never runs for ordinary Google accounts.
  - Google search pages are fixed at 10,000 rows ([paging guide](https://developers.google.com/google-ads/api/docs/reporting/paging)), so `pageToken` paging cannot shrink responses under the 1 MiB `parseExactIntegerJson` cap.
  - Fix: split `days` into consecutive sub-windows, each a `LIMIT 1001` search (about 1,000 rows × 550 B, which fits 1 MiB). Stop at 5,000 rows total, and keep the sentinel per chunk.
- Meta deleted/archived: **PARTIAL.**
  - The `<level>.effective_status IN [...incl. DELETED, ARCHIVED]` filter is added for child grains (`meta-ads/E/src/metrics.ts:28-33,41`). The enums match the SDK.
  - But `complete` is still `grain === "account"` (`:79`). So campaign, ad set and ad batches are never complete, and the original failure (child-grain reconciliation cannot pass) remains.
  - The deferral is not justified (see Disputes/deferrals): Meta documents both the default exclusion and the filter remedy.
  - Fix: `complete: true` once the filter is sent, and update the evidence entry.
- Meta zero vs null: **FIXED.** `purchase()` returns `"0"` when the `actions` key is absent or has no match, and `null` only for an explicit null or duplicate entries (`metrics.ts:58-63`). Test at `tests/read-capabilities.test.ts:79,271`.
- Meta page size: **FIXED.** Insights use `limit=200` (`read-capabilities.ts:131`), and the request cap is 27, which covers 5,000 rows plus the account read (`:100`).
- Meta Graph version: **FIXED.** One constant, `adsGraphVersion='v26.0'` (`instagram-fetch.ts:8`), is used by reads and deployment (`campaign-deployment.ts:132-133`). Renaming the dispatch is DEFERRED-OK (W-P1-2).
- Meta evidence: **PARTIAL.**
  - Entries were added (`evidence/primary-sources.json` +52 lines), but the primary Insights entries say `"access": "HTTP 429"` and `"verified": []`.
  - The primary page is readable: [Manage Your Ad Object's Status](https://developers.facebook.com/docs/marketing-api/best-practices/manage-your-ad-object-status). Add it.
- schemaFingerprint = sha256 of the whole file: **DEFERRED-OK** (note only). The values match the current files (`2eeb22f…`, `a63e04a…`, `314a1e4…`).
- RULE invokeRead complexity: the **DISPUTE is right** (see below).
- Rule-of-two:
  - `decimalMicros`: **FIXED** (thin wrappers over contracts).
  - `serviceContextSchema`: **FIXED** (imported).
  - `readContext` service→call adaptation: **NOT FIXED.** It is still copied at `google-ads/E/src/read-capabilities.ts:73-78` and `meta-ads/E/src/read-capabilities.ts:83-88`. That is DEFERRED-OK: FX-contracts was not asked for it, and plugin lanes cannot edit contracts.
  - `coverageCutoff`/zonedMidnight: **DEFERRED-OK**, same reason (google `metrics.ts:85`, meta `metrics.ts:96`).
- Integrator NEEDS: Meta now typechecks (exit 0); Google typechecks. The server binding is still broken by the cross-job ABI item.

Ledger (w2-gbp-plugin):
- plugin.json binding at a non-envelope: **FIXED.** The bindings map was replaced by inline envelope rows (`google-business-profile/plugin.json:21-40`), which `features/plugins/src/extension.ts:22,41` accepts. But see the new MAJOR below.
- reportingContext unreachable: **FIXED.** The host now supplies only a timezone (`E/src/schemas.ts:14-15`). The batch uses `currency:"XXX"`, `dataThrough:0`, `stale`, `complete:false` (`plugin.ts:142-143`).
- 31-day cap: **FIXED.** The cap is 366 and reuses the contracts `days` schema (`schemas.ts:12,22,25`).
- JINI readBody: **DEFERRED-OK** (wait for 0.6.15).
- NEEDS typecheck `@jini-ai/mcp`: **NOT FIXED.** This is the integrator's job; see Typecheck.

Ledger (Group-wide rule-of-two, c1 plugins): as above. The copied credential-card tests are gone from google, meta and GBP (rg finds no `declares identity-bound`).

New:
- [MAJOR] `google-business-profile/E/capabilities.json:17` and `plugin.json:29` declare `organic.publish.v1`. That ID is reserved in the catalog (`input: null`, `packages/contracts/src/capabilities/index.ts:61`). The server throws on any reserved row: `agent-plugin-backends.ts:139` `throw new Error('Duplicate or reserved capability')`, and `pluginDefinitions` catches it at `:536-541`.
  - Failure: once GBP is built and enabled, the whole plugin shows only `vendor_google_business_profile_unavailable`, and `report.metrics.v1` is never offered.
  - Fix: delete the `organic.publish.v1` row from both files; publishing is already "reserved" in `runtime.json`. Optionally, have the server skip reserved rows instead of throwing, as it does for unknown IDs.
- [MINOR] `google-business-profile/E/src/index.ts:4` re-exports `runCli` from `main.ts`, which imports `@jini-ai/mcp`. The server-loaded entry (`dist/index.mjs`) therefore bundles or requires Jini MCP and the MCP SDK, against the comment on line 1.
  - Failure: if MCP is not bundled, the server's import of the GBP entry fails and the plugin is unavailable; otherwise the bundle is bloated.
  - Fix: drop the export. `bin/mcp-server.mjs` already imports `../src/main.ts` directly.
- [MINOR] `google-ads/E/bindings/{report.metrics,campaign.status,tracking.tag}.v1.json` (untracked) are orphaned now that plugin.json uses inline rows.
  - They carry a stale fingerprint `648883…`, while the live rows have `2eeb22…`.
  - `apps/server/src/composition/addons.ts:289` still reads every `bindings/*.json` for effects.
  - Fix: delete the three untracked files, and the now-unreferenced tracked `search/reporting/stop/conversions.v1.json` too if nothing else reads them.
- [MINOR] `google-ads/E/src/read-capabilities.ts:100-116` (`readStatus`) has cognitive complexity of about 11 by manual Sonar count:
  - `if` 101, 103, 104 (+3);
  - `for` 106 (+1);
  - nested `if` 107, 110, 112 (+6);
  - `||` on 112 (+1).
  - This probably fails the COMMON.md gate (`sonarjs/cognitive-complexity` 10; plugins are linted per `eslint.config.mjs:8`). Fix: move the per-row validation into `statusRow({row})`.
- [MINOR] `apps/server/tests/integration-credential-cards.test.ts:148-151`: the it.each list does not include `google-business-profile`, which ships two credential cards. Add it (FX-server lane).

Disputes/deferrals:
- DISPUTED (cyclomatic >10 is not gated): **correct.** COMMON.md:25-28 and `eslint.config.mjs:12` gate cognitive ≤10 and `max-depth` 3; `complexity` is `off`. The flagged functions pass:
  - google `invokeRead` → its `work` lambda is about 9;
  - meta `invokeRead` is about 9.
  - But see the google `readStatus` MINOR above, which is about 11.
- DEFERRED "Meta child completeness, docs HTTP 429": **NOT OK.**
  - Meta's [object-status page](https://developers.facebook.com/docs/marketing-api/best-practices/manage-your-ad-object-status) states that `act_<ID>/insights?level=ad` "does not return stats for the deleted object", and that "You can query insights for DELETED objects using the ad.effective_status filter".
  - Its table also marks ARCHIVED and DELETED as excluded from `?level=` results by default.
  - The code already implements that remedy, so it should report `complete:true`.
- DEFERRED "zonedMidnight/checkCapabilityCall from contracts": **OK.** FX-contracts' job.md did not include them, and the plugin lanes cannot edit contracts. Give them to the next contracts run.
- Google "truthful partial" choice: allowed by the job text, but needs follow-up (date chunking, above).

Typecheck (typecheck-1026.txt):
- google-ads: PASS. meta-ads: PASS.
- google-business-profile: FAIL, TS2307 `@jini-ai/mcp` at `E/src/main.ts:4,5`.
  - **Cause:** `content/agent-plugins/*` is outside `pnpm-workspace.yaml`. Plugins resolve dependencies from the root `node_modules`, and the root only has `@jini-ai/platform` and `@open-marketing/contracts`. `@jini-ai/mcp@0.6.12` is already in the lockfile through `features/federation` (`pnpm-lock.yaml:446-448`). GBP src does not import `@modelcontextprotocol/sdk` directly.
  - **Smallest integrator fix:**
    1. Add `"@jini-ai/mcp": "0.6.12"` to root `package.json` devDependencies.
    2. In `pnpm-lock.yaml`, importer `.` devDependencies, add the same block as federation: `'@jini-ai/mcp': specifier: 0.6.12, version: 0.6.12(@jini-ai/platform@0.6.12(...))(@modelcontextprotocol/sdk@1.32.1(zod@4.1.13))(express@5.2.1)`, copied verbatim from line 448.
    3. Run `corepack pnpm install --offline --frozen-lockfile`.
    4. Separately, drop the `runCli` re-export (MINOR above) so the server entry does not need MCP at runtime.
    5. Add GBP to `om:build-plugins` if it should ship.

### fx-plugins-c2 — verdict: small fixes (Reddit metrics needs a short follow-up run)
Ledger (w2-metrics-a):
- Pinterest `campaign_id` → `campaign_ids`: **FIXED** (`pinterest-ads/E/src/transport.ts`, readStatus `/ads?campaign_ids=`). Test at `tests/metrics-status.test.ts:104-108`.
- Pinterest rejection fields required: **FIXED.** `rejected_reasons`/`rejection_labels` are `.nullish()` with `?? []` (`metrics-status.ts:14,47`).
- Pinterest `summary_status`: **FIXED.** `summary_status` is mapped first (RUNNING→active, PAUSED→paused, NOT_STARTED/DRAFT→pending, COMPLETED/ARCHIVED/DELETED_DRAFT→ended), and configured ACTIVE stays unknown only as a fallback (`metrics-status.ts:53-57`). Tests at `:111-113`.
- Snapchat per-campaign loop / 9-campaign cap: **FIXED.**
  - There is one `adaccounts/{id}/stats?breakdown=campaign` call (`metrics-status.ts:40-47`), and nested `breakdown_stats.campaign` is decoded atomically (`:50-90`).
  - Snap documents `campaign` as an Ad Account Stats-only breakdown ([measurement](https://developers.snap.com/marketing-api/Ads-API/measurement)).
  - New MINOR on the 31-day window below.
- Snap `engaged_view_attribution_window`: **FIXED** (dropped; not in `statsUrl`). The same page confirms it appears only in an example response.
- Pinterest UTC-only gate: **FIXED.** `readAccount` checks only id and currency, and batches are labelled `UTC` (`metrics-status.ts:36`, `transport.ts` readAccount).
- Reddit `report.metrics.v1` not_implemented: **DEFERRED-NOT-OK** (see below).
- Pinterest stale/`dataThrough:0`; Snap `complete:false` on 0 rows: **FIXED/accepted.**
  - Pinterest now reports `complete:true` and stays `stale` with `dataThrough:0`, the documented conservative choice.
  - A Snap empty, unpaged breakdown is complete (`metrics-status.ts:63,69,81`).
- Pinterest >90 days / end > today → `invalid_input`: **FIXED.** Both now return `limit_exceeded` (`transport.ts` reportMetrics). Snap end > now also returns `limit_exceeded` (`snapchat-ads/E/src/transport.ts:256`).
- OVERENG amazon/reddit `not_implemented` scaffolding: **PARTIAL.**
  - It now uses contracts `notImplemented`, but about 20 lines remain (`amazon-ads/E/src/metrics-status.ts:1-20`, `reddit-ads/E/src/transport.ts:205-209`).
  - The simpler fix is in New below.
- OVERENG `prepareCapability` ×4: **DEFERRED-OK** (there is no contracts `checkCapabilityCall`). Copies remain in pinterest `transport.ts` prepareCapability, reddit `:190-203`, snapchat `:218-228` and amazon `metrics-status.ts:12-20`.
- RULE complexity: the **DISPUTE is right.** Snap `projectCampaigns` is about 8 and pinterest `prepareCapability` about 6. But see snap `projectEntity` below.

Ledger (rule-of-two, c2 plugins):
- serviceContextSchema: **FIXED** (imported in all four).
- decimalToMicros: **FIXED** (Pinterest `metrics-status.ts:30`; Snap's local copy is gone).
- Exact-integer reader: **FIXED** (pinterest `transport.ts:178`, snapchat via `requestSnapchat(... exactMetrics)`).
- zonedMidnight: **DEFERRED-OK** (snap `metrics-status.ts:24` `midnight` is still local).
- Copied card tests: **FIXED.** Four were deleted, and none remain.

Ledger (w-vendor-cards-r2, Amazon card):
- **FIXED as data.** The card is withdrawn (`amazon-ads/plugin.json`: no `credentialCards`), and the README, SKILL and runtime record the OAuth/refresh NEEDS. But this broke a server test (New below).

New:
- [MAJOR] Withdrawing the card conflicts with the FX-server test.
  - `apps/server/tests/integration-credential-cards.test.ts:148-157` lists `'amazon-ads'` and asserts `credentialCards.length > 0`. Amazon now has zero cards, and `amazon-ads/E/tests/plugin.test.ts:167-169` asserts that.
  - Failure: the server test suite goes red on the amazon-ads case.
  - Fix (one line, server lane): remove `'amazon-ads'` from the it.each list, or allow zero cards for it. The orphaned `credentialAssets` icon (`amazon-ads/plugin.json:9`) can stay (harmless) or be dropped.
- [MINOR] Amazon's `report.metrics.v1` and `campaign.status.v1` rows (`amazon-ads/E/capabilities.json`, plugin.json) and Reddit's `report.metrics.v1` row are declared, but their handlers always return `not_implemented`.
  - Failure: the server offers `vendor_amazon_ads_report_metrics_v1` etc. as read tools that can never succeed. This is the "unbuilt capabilities surface as tools" problem.
  - Fix: remove the unbuilt rows and their handlers (amazon `unavailableCapability`, reddit `reportMetrics`), about −30 lines. Re-add them when implemented.
- [MINOR] `snapchat-ads/E/src/transport.ts:248-258` (`reportPlan`) does not check window length, but Snap caps DAY stats at 31 days ("start_time and end_time within 31 days", same measurement page).
  - Failure: a contract-valid 90-day request goes to Snap and fails with a vendor 4xx. The old per-campaign path had the same gap.
  - Fix: return `limit_exceeded` for windows over 31 days, or split into ≤31-day requests.
- [MINOR] `snapchat-ads/E/src/metrics-status.ts:93-107` (`projectEntity`) has cognitive complexity of about 11 by manual count:
  - `if` 95, 97, 98, 105 (+4);
  - `||` 97, 98 (+2);
  - ternary 97 (+1);
  - `for` 100 (+1);
  - nested `if` 102 (+2);
  - `&&` 106 (+1).
  - This probably fails the gate. Fix: move the identity/window checks (97-98) into one `entityMatches({item, required})` helper.

Disputes/deferrals:
- DISPUTED cyclomatic: **correct.** Cyclomatic is not gated; only the two functions above are over cognitive 10.
- DEFERRED "Reddit DATE response schema inaccessible": **NOT OK.**
  - The official reference (`ads-api.reddit.com/docs/v3`) is not fetchable, but a production connector documents the exact shape: Airbyte `source-reddit-ads` [manifest.yaml](https://raw.githubusercontent.com/airbytehq/airbyte/master/airbyte-integrations/connectors/source-reddit-ads/manifest.yaml).
  - It sends `POST .../reports` with `breakdowns:["AD_ACCOUNT_ID","DATE"]` (or `["CAMPAIGN_ID","DATE"]`), `starts_at` at `T00:00:00Z`, and `time_zone_id` in UTC/GMT.
  - Records come from `data.metrics[]`, with a `date` string truncated to `YYYY-MM-DD` (it may carry a time suffix), and `spend` as an integer (micros, consistent with the existing `reporting.ts` codec).
  - The existing `encodeReport` (`reddit-ads/E/src/reporting.ts:33-37`) already sends UTC. Adding `"DATE"` to `breakdowns` and a `date` column (`.slice(0,10)`) to `rowSchema` makes account and campaign UTC daily batches implementable, the same pattern as Pinterest.
  - Remaining constraints: windows are at most 31 days (`reporting.ts:13`), and Reddit lookback is about 363 days per third-party connector docs.
- DEFERRED "Amazon OAuth/refresh": **OK** (recorded as NEEDS).
- DEFERRED shared scope/timezone helpers: **OK** (contracts lane).

Typecheck (typecheck-1026.txt): amazon-ads, pinterest-ads, reddit-ads and snapchat-ads all exit 0. Nothing to fix.

Cross-job checks (both jobs):
- `createCapabilities` keyed by catalog ID: **yes, all 7.**
  - Types use `PluginCapabilitiesFactory`/`satisfies` and handlers are typed `PluginCapability<K>`.
  - No plugin factory takes authority or admission ports. Legacy adapters still carry `admitted` (pinterest/snapchat/reddit `ports.ts`) and google `HostAuthorityPort`/`StopAuthorityPort`/`ConversionAuthorityPort`, but those are outside these sections and the canonical path.
  - The `configuration` mismatch at the top of this section is the blocking defect.
- Shared helpers:
  - Used: decimal, exact JSON and serviceContext.
  - Still local: readContext, envelope/prepareCapability, midnight. That is a contracts gap, not the plugin jobs' fault.
- Copied credential-card tests are gone. The server it.each list covers all six ad plugins here, but GBP is missing and amazon-ads now fails (see above).
## R4 — Ad plugins D + LINE/Naver

Paths are relative to `content/agent-plugins/<plugin>/io.github.ainsep.openmarketing/`. I verified everything by reading code. I recomputed fingerprints with sha256 and all of them match their manifest-test bases, and plugin.json equals capabilities.json in all 9 plugins. Typecheck (typecheck-1026.txt): all 9 plugin packages exit 0.

### Cross-cutting (all 9 plugins)
- ABI: Yandex, Kakao, LinkedIn, TikTok, LINE and Naver export `createCapabilities(PluginCapabilityDependencies)` keyed by catalog ID, with no authority or admission ports on the capability path. VK exports an empty `{}` factory. **Microsoft and X export no factory.**
- Shared helpers: plugins import `decimalToMicros`, `serviceContextSchema` and `parseExactIntegerJson` from contracts, and the local copies are gone. Microsoft's `scaledDecimal` is now a 3-line wrapper. RULE PARTIAL: the capability scaffolding is still copied about 6 times (kakao/linkedin/tiktok/yandex `capabilities.ts`, line/naver `transport.ts`). The copied part is the envelope schema, the scope/connection/account binding check, credential-expiry handling and observe, roughly 30–40 lines each. A pure contracts helper (e.g. `parseCapabilityCall({call, configuration, id})`) would remove it.
- Copied credential-card tests are deleted from all 9 plugins; only shape assertions remain in manifests tests. The server it.each list (`apps/server/tests/integration-credential-cards.test.ts:148-150`) includes all 9 plugin IDs.
- No plugin has authority or admission ports on the canonical path. The conversion and deployment authority ABIs remain and are out of scope.
- [MAJOR] **Integrator NEEDS still open:** the server passes `configuration: {...state.metadata, scope, connectionId, accountId, pluginDigest}`. The plugins also need metadata the server does not yet provide: Yandex `clientLogin`/`currency`, TikTok `currency`/`timezone`, LinkedIn `currency`, Naver `credentialCustomerId`, LINE `country`/`currency`/`timezone`. Without it every call returns `invalid_input`.

### fx-plugins-d1 — verdict: another fix run (small; scoped to the Microsoft/X manifests and the X factory)
Ledger:
- BLOCKER X null→0 — FIXED. `src/reporting.ts` `dailyValue`: a null array or null cell becomes "0", an absent field becomes null, and a missing entity makes the batch incomplete. The wrong assertion (`tests/capabilities.test.ts:41-43`) is corrected and a regression test was added (:46, null SPOTLIGHT plus null-cell TREND). TF1 OAuth signing is intact: `authorization()` has no diff lines. Query values are signed from decoded `searchParams`.
- MAJOR host ABI: Yandex FIXED (`capabilities.ts:32`, `PluginCapabilitiesFactory`). Microsoft DEFERRED-OK (see below). X DEFERRED-NOT-OK (see below).
- OVERENG Yandex `checkAuthority`/`admitted()` — FIXED (removed from capabilities; tests removed).
- RULE helpers (MS/X/Yandex) — FIXED (`decimalToMicros`, `serviceContextSchema`, `parseExactIntegerJson`).
- MINOR dataThrough/complete — FIXED. Microsoft uses the window end with complete:true, including an empty report. X uses `min(window.end, retrievedAt)` when complete and 0 otherwise. Yandex uses Moscow midnight capped at retrieval time.
- MAJOR MS/X manifests + tests — FIXED (both synced; X file map has the new IDs; no `src/undefined`).
- MAJOR MS UTC gate — FIXED (`accountTimezone` dropped, `timezone:"UTC"`).
- MAJOR MS reason dedupe/caps — PARTIAL.
  - Fixed: reasons are deduplicated and truncated to 20 (`reporting.ts` campaignReview). The RPC cap is now 1000 (`transport.ts` capabilityRpc), and `limit_exceeded` breaks into a partial result.
  - Still failing: the binding limit is now the 60s plugin deadline, which drops to 30s once the server wraps it. When the deadline aborts, capabilityRpc returns `expired`, `runCampaignStatus` returns that failure, and `campaignStatus` returns `expired` for the whole batch. A campaign with roughly 150 or more ad groups (each costs at least 2 RPCs) still fails every campaign in the call.
- MINOR MS PartialErrors/CampaignType — FIXED (`decodeCampaigns` maps positional partial errors to unknown).
- MAJOR X full-catalog discovery — FIXED (`active_entities` for the window, targeted metadata with 100-ID filters, per-entity placements).
- MINOR X reviver — FIXED (shared reader: safe integers stay numbers; daily arrays keep their source text).
- MINOR X disapproval reasons — DEFERRED-OK. The finding allowed "record as gap", and it is recorded in the evidence.
- OVERENG X private capability commands — FIXED (`readCommandSchema` is private; public `commandSchema` has 3 kinds).
- MAJOR Yandex >5k rows — FIXED (rows sliced to the remaining allowance, complete:false, dataThrough 0). Regression test at `tests/capabilities.test.ts:78`. I confirmed Reports API `Page.Offset` exists (yandex.com/dev/direct/doc/en/spec).
- MINOR Yandex fixed 31-day chunks — FIXED (one CUSTOM_DATE range; test :107).
- MINOR Yandex ReportName offset — FIXED.

New:
- [MAJOR] microsoft-ads and x-ads: `capabilities.json` and `plugin.json` declare `report.metrics.v1` and `campaign.status.v1`, but `src/index.ts` exports no `createCapabilities`. Server `agent-plugin-backends.ts:143` calls `exported(...'createCapabilities')` whenever canonical rows exist; it throws, and `pluginDefinitions` (:537-541) replaces the whole plugin with one `vendor_*_unavailable` tool.
  - Failure: once the owner enables Microsoft or X, every tool of that plugin, including campaign read and deployment, becomes unavailable.
  - Fix: remove the two rows from both manifests (refresh the tests) until a factory ships, or ship the X factory.
- [MINOR] `microsoft-ads/.../src/reporting.ts` campaignReview: more than 1000 ad groups in one campaign returns `limit_exceeded`, and `runCampaignStatus` breaks on it. Every later campaign then becomes unknown, even though only this campaign was too large. Fix: break only when the RPC cap is hit; mark the oversized campaign unknown and continue.
- [MINOR] Microsoft deadline: as noted above, deadline expiry discards completed observations. Fix: stop issuing RPCs at an internal soft budget (e.g. deadline minus 5s) and return partial results.
- [MINOR] `x-ads/.../src/transport.ts` MetricsCall still carries `accountTimezone?`, a dead parameter nothing passes. Remove it.
- [MINOR] X `reportMetrics` returns not_implemented for windows over 7 days. The contract allows up to 366 days, and chunking by 7 days fits the 100-request budget for small accounts. Document this or chunk.

Disputes/deferrals:
- **"Microsoft/X canonical factory alignment remains deferred pending shared host dependencies."** Ruled on separately for each plugin:
  - **Microsoft: genuinely blocked (DEFERRED-OK).** Every call needs the developer token via `credentials.access({connectionId:"developer-token.microsoft-ads", accountId:null})` (`transport.ts` resolveCredentials). The ABI credential type requires `accountId: string`, and the server wrapper (`agent-plugin-backends.ts:690`) returns `forbidden` for any other connectionId. The host card itself says developer-token saving is "not yet supported". Contracts/server or the owner must decide where the token lives. `download` and `archiveReader` are not real blockers (guarded fetch plus an in-plugin ZIP/`DecompressionStream('deflate-raw')`), but the token alone blocks the work.
  - **X: not blocked (DEFERRED-NOT-OK).** X credentials already arrive through `credentials.access` as a JSON bundle (`resolveCredential`). The ABI covers everything else:
    - `gateway` is a pass-through, because the server invoker is the gate.
    - `timeoutSignal` can be built from `wait` plus an AbortController (Naver and LINE already do this).
    - Only `ids.next` (the OAuth nonce) is missing. The plugin could derive it from sha256(correlationId, request counter, clock), or the job could have filed a one-field ABI ask.
    - About 20 lines would have made X invocable. Instead, both plugins remain non-invocable and, per the MAJOR above, disable themselves when enabled.
- Plan deferral "X historical synchronization": fine. No disputes were filed.

Typecheck: microsoft-ads, x-ads and yandex-direct exit 0.

### fx-plugins-d2 — verdict: small fixes
Ledger:
- MAJOR host ABI (kakao/linkedin/tiktok/vk) — FIXED (catalog-keyed handlers, deadline from CallOptions, no `createDeadline`).
- OVERENG `checkAuthority` (kakao/linkedin) — FIXED.
- RULE `millionths`/reviver/serviceContext — FIXED (LinkedIn uses `decimalToMicros` and `parseExactIntegerJson`). The scaffolding copies remain (see cross-cutting).
- MINOR LinkedIn dataThrough — FIXED (`min(end, retrievedAt)` when rows < 5000).
- MAJOR TikTok `report.metrics.v1` unfinished — PARTIAL.
  - Correct: exact micros (`decimalToMicros` reject on the decimal string), null versus observed zero, unsupported conversions absent from the mapping, account-IANA day boundaries with DST handling (`accountDayBoundary`), 30-day chunks, pagination drained against total_number.
  - Missing: account grain only, so campaign, ad_group and ad return not_implemented. TikTok's integrated report supports `campaign_id`/`adgroup_id`/`ad_id` with `stat_time_day`, so per-campaign reporting is still missing.
- (part of the same) TikTok `campaign.status.v1` — PARTIAL. `capabilities.ts` campaignState maps only `DISABLE` to paused; everything else, including every ENABLE campaign, is unknown, and `secondary_status` is parsed but unused. A batch containing any running campaign is therefore never `complete`. Fix: map documented `secondary_status` values (DELETE→ended, ENABLE→active, BUDGET_EXCEED→paused, AUDIT_DENY→disapproved, etc.).
- OVERENG TikTok/VK unimplemented declarations — FIXED. TikTok is now real. VK's `capabilities.ts`, its test and the manifest rows are deleted.
- MINOR Kakao/LinkedIn 10-of-100 status — FIXED. Kakao makes 100 sequential GETs; LinkedIn uses one `BATCH_GET ids=List(...)` matching LinkedIn's documented batch-get.
- MINOR LinkedIn `numericText` drives 404 — FIXED (separate `missingAsNull`).

New:
- [MINOR] `vk-ads/.../src/index.ts:14`: an empty `createCapabilities` export plus a test (`tests/manifests.test.ts:49`). The server only requires the export when canonical rows exist, so this is dead surface. Delete both.
- [MINOR] `kakao-ads/.../src/capabilities.ts:31`: `report.metrics.v1` is still declared and always returns not_implemented. This contradicts the OVERENG rule applied to VK and TikTok. Drop the row until it is real.
- [MINOR] TikTok `reportBatch` and LinkedIn `reportBatch` both set `dataThrough = min(end, retrievedAt)` and `freshness:"fresh"` when the window includes today. TikTok data lags by about 11h and LinkedIn also lags, so coverage through now is overstated. Cap at the last completed account day, or set freshness to stale.
- [MINOR] `tiktok-ads/.../src/transport.ts` `requestTikTokRead` uses ambient `AbortSignal.timeout`. The ABI says deadlines arrive through CallOptions; the server already applies 30s.
- [MINOR] LinkedIn `adAnalytics` has a `max(5000)` element schema and a 1 MiB body cap. A large campaign-grain year fails as `protocol_mismatch`/`limit_exceeded` instead of returning partial data. This predates the fix job.

Disputes/deferrals: none filed. The TikTok-only-account-grain limitation was not reported as deferred in B1, so it is undeclared partial work.
Typecheck: kakao-ads, vk-ads, linkedin-ads and tiktok-ads exit 0.

### fx-line-naver — verdict: small fixes (plus an owner decision on LINE)
Ledger (w2-metrics-b scope note "LINE/Naver not implemented"):
- Naver `report.metrics.v1` — FIXED.
  - Per-entity daily `/stats` with `timeIncrement=1` at campaign, ad_group and ad grain.
  - `salesAmt` stays exact text and is scaled by `decimalToMicros` (KRW 1 → 1,000,000 micros, which is right because the contract says currency exponents do not apply).
  - The mapping states VAT-inclusive spend, which matches Naver's stats spec. Null is kept distinct from zero; account grain and conversion value are unsupported. `dataThrough` is always 0 (conservative).
  - Single-ID daily is correct: multi-ID `/stats` does not return daily rows.
- Naver `campaign.status.v1` — FIXED (campaign → ad groups → ads review evidence, documented rejection codes, partial-on-budget).
- LINE `campaign.status.v1` — FIXED (IDs-filtered, `includeRemoved`, documented deliveryStatusReasons codes).
- LINE `report.metrics.v1` — DEFERRED (not_implemented). Ruling below.
- Copied card tests deleted; fingerprints match their stated basis.

New:
- [MAJOR, owner] `line-ads/.../src/transport.ts:207` (and the legacy reads at :47): status is allowed only when `country === "JP"`, and TW/TH return not_implemented. LINE Ads Japan stops delivery on 2026-10-26 and its API retires at the end of March 2027, both per the plugin's own evidence. Deployment is TW/TH only. The new capability therefore serves only the market that is shutting down. Decide whether to support TW/TH reads or retire LINE.
- [MINOR] `naver-ads/.../src/transport.ts` invokeCapability, plus LINE invokeStatus: a plugin-local 15s `wait` deadline sits inside the server's 30s deadline and covers up to 100 sequential signed GETs. When it fires, the whole call fails as `expired` and completed observations are thrown away; the "partial on budget exhaustion" design only covers the request counter. Fix: drop the local timer, or check a soft time budget the same way the request budget is checked.
- [MINOR] Naver `readDailyMetrics` sends the whole window, up to 366 days, as one `timeRange`. A secondary source (digitalmarketer.co.kr) gives a 92-day limit for general `/stats` queries. Chunk at 92 days, or verify the limit against the official spec and record it.
- [MINOR] LINE `readStatus` builds a legacy dependency shim (`admitted: true`, `createDeadline: () => optional!.signal!`) to reuse `requestLineAds`. This is a forwarding layer; extract a narrow `requestLineRead({fetch, credentials, ...})` like the other plugins.
- [MINOR] LINE declares `report.metrics.v1` in its manifests while it permanently returns not_implemented. Same OVERENG rule as VK: drop the row.

Disputes/deferrals:
- LINE metrics deferral: DEFERRED-OK, but the stated reason is wrong.
  - Wrong reason: the B1 and evidence say the online-report schema has no daily boundaries. I checked the LINE spec (ads.line.me/public-docs/pages/v3/3.12.3/reporting-general-partner/): daily data exists through the async performance reports (`POST /v3/adaccounts/{id}/pfreports`, `ReportQueryParams.breakdown.time = DAY`, levels ADACCOUNT/CAMPAIGN/ADGROUP/AD, CSV download).
  - Real gaps: the spec does not state cost units (online `cost` is a bare number; only budget fields say micro) or the report-date timezone.
  - Why deferral is still fine: given those gaps and the JP shutdown, not_implemented is acceptable. The evidence should cite pfreports, and the owner should decide whether LINE is worth building.
- Naver typecheck: B1 said it failed and was fixed but not rerun. The Coordinator's run shows exit 0.

Typecheck: line-ads and naver-ads exit 0.
## R5 — Studio and content

### fx-studio-content — verdict: small fixes

Scope checked: the job's own patch (/private/tmp/om-fx-studio-content-baseline/implementation.patch) touches only its 28 lane paths (apps/studio, content/plugins/charts-*, om-playbook, seo, email-lifecycle). Nothing outside the lane changed, and nothing in shared contracts/lockfile/workspace was touched. The plugin-ABI, shared-helper, card-test and authority-port checks don't apply to this group: these are chart providers and skills-only packages, with no `createCapabilities`, no credential cards and no ports.

Ledger, w-bw-theme:
- OM Ink missing from picker + 3 tests (MAJOR) — FIXED. AppearancePicker.tsx:17 adds an explicit `themes[5]` row. No functions sit inside the component body; ThemeChoice/AccentChoice stay module-level. In theme-pack.test.ts:4, `themeIds` now includes "om-ink", so OM Ink goes through the scoped/token-only check (:81), the index import order (:93) and every AA pair in `states` (:45, :96). I hand-checked the riskiest pairs. Dark control-border #737373 on #101010 is ≈4.0 (needs ≥3). Dark muted #b3b3b3 on #101010 is ≈9. Light #737373 on #fff is ≈4.7. All required roles at :99 are present in om-ink.css. appearance.test.ts:119 adds `"om-ink":"default"`. shell.test.ts:161 adds the OM Ink row, :176 expects 6 previews, and :264 now expects the final theme to be "om-ink", since the composed-handle loop at :242 walks THEMES in order and composition/index.ts:70 derives handles from THEMES. No other theme enumeration exists in apps/studio, server or the site guide.
- om-ink.css near-copy of mono.css (OVERENG) — DEFERRED-OK. The owner decided to keep both themes (ctx-fix-1026 shared decisions).
- Integrator NEEDS (picker row + 3 tests) — FIXED (same as the MAJOR).

Ledger, w-chat-polish (non-regression check):
- Hand-inserted `<style data-jini-remixicon>` (JINI, optional) — DEFERRED-OK. Jini supports this override, and the fix job didn't touch main.ts, style.d.ts, chat.css or chat-parity.test.ts. Their diffs vs HEAD are unchanged from last night's wave. No regression.
- `assistantUsageSchema.costUsd` float (RULE, pre-existing) — not in this lane and still open. packages/contracts/src/api/index.ts:25 is unchanged, and chat-parity.test.ts:167-207 still uses `.07`/`.23`. This is consistent: nothing broke, but nothing was fixed either. It belongs to the contracts owner, and it is also a Jini shape, since `formatUsageCost` in @jini-ai/chat takes dollars.
- Attachments (CB1 R2) / browser comparison NEEDS — unchanged, not this lane.

Ledger, w-vendor-cards-r2 (studio items):
- That job changed no apps/studio files, and the fix wave added none. The studio items in its NEEDS (DS2 card rendering) are still absent, which is not a regression.

Ledger, w-chart-plugins:
- Never typechecked (MAJOR) — DEFERRED-OK. This is genuinely blocked: the lockfile has no echarts, zrender, tslib@2.3.0, chart.js or @kurkle/color entries, and the packages aren't workspace members. The Coordinator's typecheck-1026.txt has no chart entries. Both packages are still uncompiled and unrendered, and the merge gate still applies.
- Full `echarts` / `chart.js/auto` imports (MINOR) — FIXED.
  - charts-echarts/src/provider.ts:2-10 imports from `echarts/core`, `echarts/charts`, `echarts/components` and `echarts/renderers`. `use([...])` registers exactly the parts the option builder uses: Line/Bar/Funnel/Heatmap, Grid (cartesian + heatmap), Tooltip, Title (title/subtext), Legend, VisualMap (heatmap) and CanvasRenderer. `getInstanceByDom` comes from `echarts/core`. The only import from `echarts` is type-only (:3), so it is erased. I confirmed on npm that echarts 6.1.0 exports `./core`, `./charts`, `./components` and `./renderers`.
  - charts-chartjs/src/provider.ts:2-7 registers Line/Bar controllers, Line/Point/Bar elements, Category/Linear scales and Title/SubTitle/Legend/Tooltip. No fill or Colors plugin is used.
  - New regressions: echarts tests/provider.test.ts:24-28 and chartjs tests/provider.test.ts:24-28. Both re-import after `vi.resetModules()` and assert the exact registration list. Both would fail on the old full imports.
- `@open-marketing/charts-*-build` package scope (MINOR) — FIXED. The packages are now `@open-marketing-plugin/charts-echarts` and `@open-marketing-plugin/charts-chartjs`, and build-artifact.mjs doesn't read the name.
- Byte-identical build-artifact.mjs (OVERENG) — DEFERRED-OK. The review accepted the copy, and it is still identical.
- Upstream to Jini (JINI) — keep, per the rules.

Ledger, w-ad-copy-skill:
- Meta feed rows all "Unknown" (MINOR) — DEFERRED-NOT-OK. The primary Meta Ads Guide pages are public. I fetched both without logging in today:
  - https://www.facebook.com/business/ads-guide/update/image/facebook-feed gives "Text Recommendations: Primary Text: 50-150 characters; Headline: 27 characters". It gives no description figure.
  - https://www.facebook.com/business/ads-guide/update/image/instagram-feed gives "Primary Text: 125 characters; Headline: 40 characters; Maximum Number of Hashtags: 30".
  - These are exactly the URLs that references/platform-limits.md:9-10 cites as "redirected to login".
- ad-copy pin `e85f3cbc…` vs the other five at `7868cb92…` (MINOR) — DEFERRED-NOT-OK. The stated blocker is false: `skills/ads/references/ad-copy-templates.md` returns HTTP 200 at 7868cb92 from raw.githubusercontent.com, and it is byte-identical to e85f3cbc (4,821 bytes, `diff -q` clean). LICENSE is identical at both revisions. `skills/ad-creative/SKILL.md` differs, but every adapted part is present at 7868cb92: "Grounded Inputs" (:71), "Step 1: Define Your Angles" (:179), "Step 2: Generate Variations per Angle" (:196) and "Step 4: Organize for Upload" (:208). The GitHub compare API also shows e85f3cbc is 883 commits *ahead* of 7868cb92. The ad-copy job pinned the newer revision and skills2 pinned an older one.
- om-playbook NOTICE "No vendor source copied" (MINOR) — FIXED. NOTICE:2 reads "Includes MIT-licensed material adapted from coreyhaines31/marketingskills; see skills/*/PROVENANCE.md." All six PROVENANCE files exist, each cites only that repo, and each carries the full MIT text. This is accurate. Nit, pre-existing and copied from google-ads: NOTICE:1 says "Agent Plugins format 1.1.0", while plugin.json `$schema` is 1.0.0.
- Caveat repeated five times (OVERENG) — FIXED. SKILL.md:66 holds the single consolidated caveat paragraph. The only other mention is the frontmatter description (:3), which is needed for discovery. platform-limits.md:3 points back to SKILL.md instead of repeating the caveat.

Ledger, w2-skills2:
- Hub skill and manifest don't list the six skills (MINOR, marked "Fix (integrator)") — DEFERRED-OK on assignment. Both files are inside this job's lane (content/agent-plugins/om-playbook/), though, so it's a 2-line edit that can ride along with the re-pin.
- No positive fatigue/test signals (MINOR) — FIXED. creative-fatigue-review/SKILL.md:26-28 covers CTR falling while frequency rises and CPM stays flat, and verified-lead conversion falling with stable clicks. creative-test-plan/SKILL.md:22-23 covers a refreshed treatment recovering against an unchanged control. All three are qualitative, with no thresholds, and say "Neither pattern proves a cause."
- Repeated opener/closer in five skills (OVERENG) — DISPUTE UPHELD. addons.ts:277-279 returns only the selected skill's markdown (`readInstalledSkillMarkdown({ skillPath: skill.skillPath })`), so hub text is never loaded with a sub-skill. Moving the caveat into the hub would silently drop it. Each skill now has one 1-2 line sentence for it (strategy :10, analytics :9, cro :9, fatigue :10-11, test-plan :9-10), and the closer is a one-line PROVENANCE link. That is the right minimum.

Ledger, w2-topic-plugins:
- PROVENANCE dropped on install / dead link (MINOR) — FIXED. Root PROVENANCE.md was moved to seo/skills/seo/PROVENANCE.md and email-lifecycle/skills/email-lifecycle/PROVENANCE.md, and the root copies are gone. Since addons.ts:394 copies `skills/`, the files survive install. Links are at seo SKILL.md:97 and email-lifecycle SKILL.md:107.
- "Catalog inclusion not part of this delivery" wording (MINOR) — FIXED. Both PROVENANCE files now say the package is auto-seeded into the bundled Add-ons catalog and desktop packaging, disabled by default.
- MIT with only upstream copyright (MINOR) — FIXED. Both LICENSE files add "Copyright (c) 2026 AINSEP (Open Marketing adaptations)". The upstream lines match the real upstream LICENSEs: I verified "2026 agricidaniel" and "2026 jacquescorbytuech" at the pinned commits.
- "validated calculator/tool" vs "product code" (MINOR) — FIXED. email-lifecycle SKILL.md:120-122 now says "Product code must compute sample size and numerical decision evaluation; leave both pending".

New:
- [MINOR] content/agent-plugins/om-playbook/skills/ad-copy-variants/SKILL.md:59-60 and references/platform-limits.md:9-11 — these state that the Meta guides "redirected to login". That is false today; both pages are public (see above).
  - Failure: the most-used placements still have no length guidance, and the reference records an untrue access claim.
  - Fix: replace the two rows with Rec values from the Ads Guide. Facebook feed image: primary 50–150, headline 27, description Unknown. Instagram feed image: primary 125, headline 40, ≤30 hashtags. Keep the maximums Unknown, and fix platform-limits.md:9-11 to cite the guide as verified on 2026-10-26.
- [MINOR] content/agent-plugins/om-playbook/skills/ad-copy-variants/PROVENANCE.md:4-6 — "the adapted ad-copy-templates source there could not be retrieved" is untrue.
  - Failure: two pins remain for one upstream, and the regression test enshrines the gap: apps/studio/tests/bundled-skill-content.test.ts:52-61 checks only `playbookSkills.slice(1)`, and :61 is an `it.todo`.
  - Fix: re-pin ad-copy to `7868cb9251fad80a73d26e488a5ad5f6c4a9f335`. That means rewriting the 3 URLs plus the license URL and deleting the "Pin alignment pending" line. Then drop `.slice(1)` at :53 and delete the `it.todo` at :61.
- [MINOR] apps/studio/tests/bundled-skill-content.test.ts:4 — a content-package test lives in the Studio app, and it reads `../../../content/agent-plugins/`. Studio never consumes these packages; the server seeds them (apps/server/src/composition/addons.ts:384-399, already tested in apps/server/tests/addons.test.ts).
  - Failure: Studio's suite becomes the gate for skill licensing and provenance, so a Studio-only test run (or a Studio extraction) silently stops covering them. Lane limits forced this placement.
  - Fix: at integration, move the file to apps/server/tests/ next to addons.test.ts. It needs no code changes.
- [NEEDS gap, not a defect] B1 omits that nothing seeds or packages the two new chart plugins. Server seeding is hard-coded to charts-recharts (addons.ts:188-189), and so is desktop packaging (development/scripts/package-desktop.mjs:102-104). Per the owner, charts are uploaded plugins, so upload-only may be intended. The owner or integrator should either confirm "upload-only" or add both to the seed and packaging lists after the artifacts are built.

Disputes/deferrals:
- DISPUTED "move caveats into hub" — upheld (addons.ts:279 loads only the selected skill).
- DEFERRED Meta recommendations ("Help page redirects to login") — NOT justified. The Ads Guide placement pages are publicly readable, and the Help page isn't needed.
- DEFERRED ad-copy upstream pin ("template unavailable at common revision") — NOT justified. The file is retrievable and byte-identical, and the license is identical. Note for the fixer: 7868cb92 is the older commit, and re-pinning ad-copy down to it is correct because all the adapted material exists there. The alternative, moving the five skills up to e85f3cbc, would need re-verifying five sources.
- DEFERRED chart provisioning/artifacts — justified. These are lockfile/workspace changes owned by the integrator, and they are forbidden to fix jobs.

Integrator NEEDS (exact, chart plugins):
1. pnpm-workspace.yaml `packages:` — add two explicit entries, `- content/plugins/charts-echarts` and `- content/plugins/charts-chartjs`. Don't use `content/plugins/*`: charts-recharts has no package.json, so a glob only works by accident and would also pick up future directories.
2. package.json — no edits needed; both are already declared exactly.
   - charts-echarts: `"dependencies": {"echarts": "6.1.0"}`. It pulls in zrender 6.1.0 and tslib 2.3.0, per npm 6.1.0 metadata.
   - charts-chartjs: `"dependencies": {"chart.js": "4.6.1"}`. It pulls in @kurkle/color ^0.3.0.
   - devDependencies in both: `@jini-ai/ui 0.6.12`, `@types/node 24.10.1`, `esbuild 0.25.12`, `jsdom 27.2.0`, `typescript 5.9.3`, `vitest 3.2.4`. All six are already in pnpm-lock.yaml.
   - Both latest dist-tags confirm 6.1.0 and 4.6.1 exist.
3. pnpm-lock.yaml — hand-add two importers, `content/plugins/charts-echarts` and `content/plugins/charts-chartjs`, plus new packages/snapshots for echarts@6.1.0, zrender@6.1.0, tslib@2.3.0, chart.js@4.6.1 and @kurkle/color. The importers' `@jini-ai/ui` must point at the existing peer snapshot `0.6.12(073fe5694e13dbae570bcfd20a75440e)`, because the lock has `autoInstallPeers: true` and the chart packages declare no react. Then run `pnpm install --offline --frozen-lockfile` (non-frozen install is forbidden). If the peer hash doesn't match, add `react`/`react-dom` 19.2.0 as devDependencies so the importers resolve to the same snapshot.
4. Then, in an authorized run, for each package: `typecheck`, then `build:artifact`. That generates `0.1.0/client/provider.js`, appends the bundled license texts to `0.1.0/NOTICE` (ECharts: echarts, zrender, tslib; Chart.js: chart.js, @kurkle/color) and writes the 4-entry `integrity` map in `0.1.0/jini.plugin.json`, which is `{}` today, so neither plugin is installable yet.
5. Optional: seed and package both plugins (addons.ts:188, package-desktop.mjs:102), or record that they are upload-only.
6. Also integrator-assigned: the om-playbook hub skill list (skills/om-playbook/SKILL.md) and the plugin.json description.

Typecheck: `@open-marketing/studio exit=0` (typecheck-1026.txt:4) covers the picker, the three theme tests and the new bundled-skill-content test. There are no failures in this group. The chart packages were not typechecked and cannot be until NEEDS 1-3 land. The skills packages have no TypeScript.
