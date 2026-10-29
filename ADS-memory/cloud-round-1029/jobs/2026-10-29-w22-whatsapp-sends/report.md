Programmer(Direct): Implemented the approved-template send ABI for the existing owner-only `om_message_send` path. The owner can supply a template name, language and body variables alongside the recipient and USD ceiling. Before authority, the plugin checks USD WABA currency and current template approval/category; it then quotes exact micros rounded upward into host USD cents and permits one POST. Production sending remains unavailable: primary USD rate numbers could not be retrieved, so the production table is empty and every send refuses `not_implemented` before reservation. The complete prefix mapping is also deferred; only the binding review's examples are transcribed. Production remains read_only.

## CHANGED FILES

All product paths are under `content/agent-plugins/whatsapp-business/`:

| File | Change |
| --- | --- |
| `io.github.ainsep.openmarketing/src/broadcast.ts` | Replace unused broadcast API with `sendMessage`, strict message schema and `messageChannel`; two pre-authority GETs; quote/digest; retain single-shot POST, receipts, redaction and uncertainty. Recheck credential/quote expiry and cancellation at execute; observer operation becomes `whatsapp-business.send`. |
| `io.github.ainsep.openmarketing/src/rates.ts` | New plugin-local rate data and pure `maximumRate`: longest prefix, authentication-international maximum, unknown-prefix maximum, exact shared decimal conversion. No verified production rate rows. Partial mapping explicitly marked. |
| `io.github.ainsep.openmarketing/src/index.ts` | Export send API/schema/inferred types; remove broadcast exports without a wrapper. |
| `io.github.ainsep.openmarketing/tests/fixtures.ts` | Separate GET/POST captures, synthetic rates/template/currency, quote-only authority, injected deadlines/clock/credential failures; remove unused fixture webhook-apply scaffolding. Read-adapter fixtures retain createDeadline. |
| `io.github.ainsep.openmarketing/tests/broadcast.test.ts` | Migrate existing assertions and write approval/pricing/strict-input/expiry/redaction regressions. |
| `io.github.ainsep.openmarketing/evidence/primary-sources.json` | Dated primary evidence, failed CSV retrieval, incomplete map and activation limits. |
| `README.md` | Describe existing host send path, message/card shape, fail-closed pricing, supported templates and deferrals; preserve webhook guidance. |
| `skills/whatsapp-business/SKILL.md` | Direct assistant use of the host path, exact approval and current availability limits. |

Job records under `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-whatsapp-sends/`: `progress.md`, `report.md`, `typecheck.txt` (log only). No other files edited. No server, ports.ts, manifests, lockfile, contracts, dist, migrations or sibling-repository edits. Existing dirty/untracked work was preserved; no commit/push/stage/stash.

## TESTS (written, not run)

`tests/broadcast.test.ts` drives the real plugin with fixture dependencies. Added assertions cover:

- `messageChannel === "whatsapp"` and server-shaped configuration without local admission flags.
- Missing, non-APPROVED, wrong-name/language, duplicate, malformed, unknown-category and incomplete/oversized template evidence: no authority and no POST.
- Non-USD/missing currency: refuse before authority.
- Longest-prefix NANP exceptions and unknown-prefix maximum; authentication uses the larger domestic/international rate in either ordering; exact micros and ceiling cents.
- Empty production rates, empty fixture table, missing category and malformed/sub-micro/negative decimal evidence: no reservation/POST and no raw evidence in errors.
- Exactly two bound GETs with one credential access per invocation; no credential cache across invocations; frozen-POST digest, dated price evidence, exact quote/digest/execute authority shape and injected deadlines.
- Authority denial, single-shot execute, repeated delivery-key dedup and changed-input conflict (the latter two are synthetic host behavior, not proof of production durability).
- Strict rejection of free-form and nested connection/credential overrides; cancellation before credentials and at execute; credential and quote expiry.
- Credential parsing/lookup failures and provider exceptions never expose token, credential JSON or phone in failures/observer events.

Existing accepted/unknown, malformed/oversized/failed receipt, normalized wa_id, 429 and Meta throughput-code assertions remain on the new API. No unique production assertion was deleted. Red/green and coverage evidence are unavailable because the owner explicitly prohibits tests on this machine. No tests, builds, installs, om:check, watch modes or live vendor calls were run.

## TYPECHECK

`corepack pnpm --dir content/agent-plugins/whatsapp-business typecheck`

- Run 1: FAIL, exit 2; two TS2322 errors in heterogeneous invalid-rate test arrays (`{}` inferred as an optional record key). Annotated those arrays with the schema-derived `Rates[]` type; no production source errors were reported.
- Permitted corrective rerun: PASS, exit 0, no diagnostics. Full command/result summary is in `typecheck.txt`.
- Server typecheck skipped exactly as required by the review/Coordinator override: no server edits. No further typechecks run.

Read-only scoped `measureSource` from `development/scripts/metrics.mjs` inspected only the five touched TS files, without invoking the repository report/check or writing metrics artifacts. All measured functions satisfy cognitive <=10 and nesting <=3; tests max 5/2, fixtures max 6/2. Scoped tracked-file `git diff --check` reported no whitespace errors.

| Source unit | Cognitive | Nesting | Cyclomatic (reported only) | NLOC (reported only) |
| --- | ---: | ---: | ---: | ---: |
| sendMessage | 5 | 2 | 9 | 16 |
| authorize | 8 | 3 | 10 | 23 |
| priceQuote | 7 | 1 | 11 | 23 |
| readGraph | 2 | 1 | 5 | 11 |
| submit | 7 | 3 | 11 | 17 |
| receipt (preserved logic) | 10 | 2 | 14 | 17 |
| maximumRate | 8 | 2 | 11 | 18 |
| observe | 2 | 2 | 3 | 5 |

## CONTRACTS

Plugin public API: `messageChannel = "whatsapp"`, `sendMessage`, `whatsappMessageSchema`, `whatsappDeliveryReceiptSchema`, `WhatsAppMessage`, `WhatsAppMessageDependencies`, `WhatsAppDeliveryReceipt`. Input: `{ context, deliveryId, recipient, message: { template: { name, language, bodyParameters } } }`. Old broadcast API, definitionId and subjectId are removed. Read/webhook APIs remain.

Dependencies pick configuration/credentials/fetch/clock/observer from PluginCapabilityDependencies and add the existing host deadlineSignal/authority ABI. Authority takes only `{ quote, argumentsDigest, execute }`. Types derive from schemas; quote is the shared generation-cost subset. The optional rate-table argument is only the approved fixture seam; it is absent from the strict host tool message schema and from configuration. No shared contract or new policy/host tool/dependency/queue/port.

MIGRATIONS: none.

## REUSE / DISCOVERY

- Reuse: template evidence/credential/bounded JSON parsing; inspected WhatsApp `commands.ts` templatesSchema and `transport.ts` parseCredential/readBody; called those existing owners. Existing POST/receipt behavior retained in place.
- Reuse: money and quote contracts; inspected contracts decimalToMicros, moneySchema and generationCostQuoteSchema; called shared conversion with rounding reject and used the quote subset. No parallel money parser.
- Reuse: approval, consent, STOP, subject lane, durable dedup/outbox and reserve/settle; inspected `apps/server/src/composition/agent-plugin-backends.ts` messageSendDefinition/dispatchMessage/messageExecution/callMessage/messageAuthority. Channel is generic, so no server change. Twilio's reviewed send ABI is a style/contract precedent, not an imported plugin dependency.
- Searches: published Jini 0.6.15-rc.2 dist and read-only Tovu apps/packages plus ai-traces-jini packages for whatsapp, message_templates, callingCode and USD list rates; no matching implementation (only unrelated SEO text in sibling sources). No unpublished APIs or stale Jini source facts used. Vendor-specific pricing/template evidence remains in this plugin; no JINI ASK.
- Phone library dependency was cut by the review. No libphonenumber, SDK, CSV reader, rate scraper, pagination loop, retry mechanism or new telemetry layer added. Existing observer reused.

Primary docs: [Meta public pricing](https://whatsappbusiness.com/products/platform-pricing/) confirms market/category pricing but retrieved content exposes no numeric rows. Linked rate-card page returned 429; [pricing.md](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing.md) was inaccessible in this build. No usable CSV href was exposed, so no numeric CSV fetch was possible. The binding review's retrieved prefix examples are identified as review evidence, not falsely reported as re-fetched. [Meta SDK 26.0.2](https://raw.githubusercontent.com/facebook/facebook-python-business-sdk/26.0.2/facebook_business/adobjects/whatsappbusinessaccount.py) confirms WABA currency and template-list name/category/status fields. Evidence JSON records URLs, 2026-10-29, and limits; no third-party rates used.

## RISKS / DEFERRED

- Activation DEFERRED: no primary numeric rates verified. Empty production table denies before authority. Full market mapping is also incomplete: adding rates before completing remaining NANP exceptions could underquote numbers currently falling under +1. Complete/review that mapping together with the CSV; the current partial table is not production pricing evidence.
- No automatic rate expiry/update (approved default). Edition date is hashed; quarterly changes may raise prices. Follow-up maintenance and real-account permission/compatibility checks are required before production activation.
- Template/category can change between GET and POST; no vendor atomic approval/send API is assumed. Unsupported parameter forms remain refused by OM input; Cloud API remains responsible for actual template-variable validation.
- DESIGN NOTE: host passes intent to policy but not to the plugin; a MARKETING template under transactional intent can bypass marketing-purpose/holdout checks. Scope explicitly defers the coordinated host/Twilio schema correction. Production remains read_only.
- DEFERRED: free-form/24h-window proof, media/header/button/named parameters, template creation, broadcasts/scheduling, billed-price reconciliation/FX, dedicated Studio composer, server WhatsApp fixture test (review CUT 2), live-account evidence and production enablement. Existing webhook challenge/subscription/alias work remains outside scope.
- Fixture tests are written and typechecked, not executed. No functional green/runtime/delivery guarantee is claimed.

## NEEDS

- OWNER: download Meta 'USD list rates (CSV)' (effective 2026-10-01) from developers.facebook.com/documentation/business-messaging/whatsapp/pricing into this job dir; a follow-up fills rates.ts.
- Complete and verify the full primary country-calling-code/prefix mapping, including all NANP exceptions and +7 market handling, before adding production rate rows.
- DESIGN NOTE / later w15-backends: host passes `intent` to sendMessage; WhatsApp refuses a MARKETING-category template under transactional intent. Coordinate with Twilio's strict schema; no host edit in this job.
- COORDINATOR: rebuild WhatsApp plugin dist and refresh bundle integrity/digest after review. No plugin build was run here.

## QUALITY / ARCHITECTURE AUDIT

Architecture status: PASS for plugin/host ownership and approved file boundaries. Activation/data readiness: PARTIAL. Checked all eight product files: vendor code stays plugin-local; only public contracts imported externally; existing host owns authority/outbox/accounting; injected I/O/clock/deadlines; strict boundary parsing; one call-local credential access; zero POST on evidence refusal; bounded two GETs and one single-shot POST; no retry/registry/new dependency. No ADR index or task-local certified test hash was supplied; direct approved scope governs. Tests remain unexecuted by owner instruction.

| Assessment unit | Disposition | Findings / local fix |
| --- | --- | --- |
| maximumRate + rate data | RECOMMENDED | Medium:data-readiness: full primary mapping/numeric rows unavailable. Kept production table empty and documented mandatory completion before rate activation; no invented values. O(p log p+r) time, O(p+r) space; fixed prefixes, <=100 rate markets. |
| sendMessage + schemas | NO_RECORDED_FINDINGS | Strict scoped template-only input; actual plugin seam in tests. Bounded input/request transformation; no hidden I/O. |
| authorize + execute | NO_RECORDED_FINDINGS | Single credential access and single-shot execute; digest binds request; all refusal/expiry/authority cases injectable. O(b) retained request/evidence. |
| priceQuote + readGraph | NO_RECORDED_FINDINGS | Two bounded <=1MiB/10s reads and <=100 template rows; malformed/incomplete evidence refuses, no pagination. O(b+n) time/space. |
| submit + receipt | NO_RECORDED_FINDINGS | One <=1MiB/10s POST; credential/quote expiry checked, ambiguous outcomes retained. O(b) time/space. |
| failure / unknown / observe | NO_RECORDED_FINDINGS | Fixed redacted values and existing observer; constant-size output, context IDs retained. Observer failure cannot change outcome. |
| Fixture/authority and migrated tests | NO_RECORDED_FINDINGS | Call-local state; direct output/GET/POST/quote assertions; no global mocks. Removed unused apply fixture, preserved unique assertions. |

Critical/High code findings: 0. The known intent gap is a deferred host-level policy issue explicitly accepted by the review; no claim that it is fixed. Runtime assessment is inconclusive because tests/live probes are prohibited. A second manual review checked misleading variable names (maximum is the rate maximum; estimated is the same ceiling intentionally), wrong-language/duplicate templates, missing category, unknown prefixes, credential refresh, ambiguity and boundary scope. Data readiness remains the recorded finding, so no claim of a findings-free change. No new singletons, time reads, broad registry or speculative ports. Module imports remain inert.

Documentation classification: public send/schema/dependency exports stale-doc-updated/documented; rate/evidence exports documented; trivial private failure/unknown mappers intentionally inherit parent behavior docs. Reviewed source comments/README/skill against shipped availability. No runtime validation or coverage measurement performed: prohibited by owner. Direct seams exist for all new decision/effect paths; written cases do not establish measured coverage.

## NET LOC / HANDOFF

Against the in-session pre-edit working-tree baseline (not HEAD, which already has other jobs' work): product files +426 / -124 = **net +302 lines**. Source/data +143/-37 = +106; tests +221/-64 = +157; docs/evidence +62/-23 = +39. Job records/log excluded. The measurement uses a line LCS and preserves unrelated dirty state.

Pre-completion: re-read approved scope and override; confirmed only listed files changed; retained assertions and no test weakening; fresh lane typecheck PASS on the permitted rerun; scoped complexity measurement PASS; no commits/live effects. All implementation items handed off, with pricing activation/full mapping explicitly unfinished due inaccessible primary evidence. Progress checkpoint includes completed files and outstanding work. No extra session/framework files were written because the lane restricts edits to the listed files.

HANDOFF: Coordinator reviews source/tests and the data-readiness deferral; owner supplies the primary CSV/full mapping evidence; follow-up populates and reviews rates; later coordinated host job closes intent enforcement. Coordinator owns dist/digest rebuild and production enablement. No unattended/live spend authorized or performed.
