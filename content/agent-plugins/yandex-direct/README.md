# Yandex Direct — reads/auth and grouped DRAFT backend

Server-loaded Agent Plugins 1.1.0 package. After separate host integration, an owner can ask OM's assistant to list connected/agency accounts, inspect campaigns, or report account/campaign impressions, clicks and cost. Ships disabled and unadmitted. No distribution has been generated; this folder is outside workspace globs.

## Connection

Use OM's existing server-side paste-token credential flow. Register an app with Yandex ID for `direct:api`; organization authorization also uses `passport:business`. Obtain approved Direct API access, accept the API agreement, and authorize the Direct representative. Paste the token only into the server credential surface, never chat, skills, agent configuration, logs or source. App review can take up to seven days. [Registration](https://yandex.com/dev/direct/doc/en/concepts/register), [access requirements](https://yandex.com/dev/direct/doc/en/concepts/access).

This plugin has no OAuth descriptor, token store or refresh loop. Yandex documents code/PKCE and refresh exchanges, but loopback redirect acceptance is UNVERIFIED; browser sign-in remains unavailable. Expiry is permission-dependent; the broker supplies `expiresAt` in epoch milliseconds when known. Expired/revoked pasted tokens require reconnecting. [Code flow](https://yandex.com/dev/id/doc/en/codes/code-url), [lifetime](https://yandex.com/dev/id/doc/en/concepts/ya-oauth-intro), [refresh](https://www.yandex.com/dev/id/doc/en/tokens/refresh-client).

## Server binding and reads

The only public entry is `io.github.ainsep.openmarketing/src/index.ts` (distribution: `dist/index.mjs` under that namespace). Imports/factories are inert.

```ts
const adapter = createYandexDirectAdapter({ configuration, admitted, credentials, gateway, fetch: guardedFetch, clock, observer });
const result = await adapter.invoke({ context, operationId,
  command: { kind: "list_campaigns", ids: ["456"], limit: 100, offset: 0 },
  moneyExposure: null, requiredLimit: null,
}, { signal });
```

`configuration` binds scope, connectionId, optional accountId/clientLogin/currency, apiVersion `v501`, installed pluginDigest and bindingId. `admitted()` synchronously reads current host admission; false prevents all credential/network access and is rechecked inside execute. `credentials.access({connectionId, accountId?}, options)` returns `{accessToken, expiresAt?}`. The broker owns custody, scope and any refresh support. Accountless lookup is allowed only for discovery and needs a narrow integrator binding.

`gateway.dispatch` receives context, configuration, operation, frozen request bytes/headers, canonical read EffectEnvelope and `execute()`. AFTER token lookup, the server checks current admission, connection, scope, account ID to representative login/currency binding and authority, holds its safety fence through execute, and appends egress audit with operation/run/correlation/trace IDs. The callback can send once. Durable operation identity belongs to the existing host outbox; this plugin adds no journal or policy. The request digest binds configuration and exact wire data. Injected fetch retains the standard fetch ABI and must honor its AbortSignal during response reads.

- `list_accounts({kind:"list_accounts", view:"connected"|"agency", limit?, offset?})`: connected calls Clients.get without paging (offset must be zero); agency calls AgencyClients.get with an explicit page. Both omit Client-Login. ClientId is the advertiser/agency ID; Login identifies a representative. Discovery candidates grant no account access. Agency identity may omit currency.
- `list_campaigns({kind:"list_campaigns", ids?, limit?, offset?})`: Campaigns.get with fixed ID/name/type/state/status fields. IDs are unique decimal strings representable exactly as JSON numbers. Requires host-bound ID/login/currency; the host verifies that mapping, since campaign rows carry no account ID.
- `report({kind:"report", view:"account"|"campaign", dateFrom, dateTo, campaignIds?, limit?, offset?})`: fixed daily account/campaign TSV views; filters only in campaign view. Inclusive calendar dates, maximum 31 days. Source, account, currency, injected retrieval time, VAT exclusion and micros unit are explicit. Counters/micros stay decimal strings without floating-point conversion. Calendar dates retain provider semantics; do not sum them into normalized cross-platform UTC totals.

Limits: 64KiB input, 1MiB streamed response, 15-second fetch/body deadline, lists <=100 rows, reports <=1000 rows, offsets <=1,000,000; one request, no redirect, retry, automatic paging or offline polling. Full pages are potentially incomplete; nextOffset is an explicit next-call hint. At the offset cap incompleteness can remain true with no continuation. Empty reports mean no data/access unconfirmed, never zero spend. Pages reject atomically on duplicates, malformed values, unrequested campaigns or inconsistent continuations; unknown vendor fields/links are stripped.

When integrating, supply `createDeadline: ({ milliseconds }) => AbortSignal.timeout(milliseconds)` from the server composition alongside fetch, clock, credentials, gateway and observer. The adapter requests a fresh 15-second signal per dispatch and combines it with caller cancellation; fixture tests inject manually aborted signals without real timers.

JSON services use lowercase `/json/v501/{service}`. Reports force `processingMode:online`, skip the report title/summary and validate column names. Default money values are integer micros; VAT is explicitly excluded. API sunset guarantees and vendor create-idempotency are UNVERIFIED. Host rate limiting must honor five simultaneous advertiser calls, per-advertiser point quotas and Reports' 20 calls/10 seconds per user. [Request format](https://yandex.com/dev/direct/doc/en/format), [report specification](https://yandex.com/dev/direct/doc/en/spec), [report headers](https://yandex.com/dev/direct/doc/en/headers), [quotas](https://yandex.com/dev/direct/doc/en/concepts/units), [report restrictions](https://yandex.com/dev/direct/doc/en/restrictions).

## Deferred and integration handoff

Tools remain read-only; the separate R2 grouped backend declares `campaign.create-draft.v1` with the existing write effect. Production exposure is blocked pending weekly-budget support and account/login, region, creative, currency and schedule resolution. No spend, activation, moderation, upload, keyword mutation, halt backend or conversion capability exists here. Metrica delivery remains explicitly deferred pending owner ratification. No runtime.json, registry, scheduler, vendor SDK, Jini dependency, shared-file edit or migration.

NEEDS integrator: add catalog/factory/schema exports and accountless discovery to `apps/server/src/composition/agent-plugin-backends.ts`; bind paste-token credentials/current admission/gateway/guarded fetch, verified account/login/currency and host rate limiting; add root `om:build-plugins`, dependency/lock wiring and `om-tool-coverage.ts`; instantiate `tests/contract/dispatch-suite.ts` against server bindings and extend server tests. DS2 owns existing connection/report presentation; HTTP/studio/CLI/assistant exposure is not delivered by this folder. Reuse exact pins in package.json; no install was performed. Coordinator must verify pending npm metadata for TypeScript/Vitest/Node types before dependency wiring.

Research is documentation evidence, not live vendor acceptance. See `io.github.ainsep.openmarketing/evidence/primary-sources.json` for quotes, consumed fields and blocked pages. The API's documentation is reachable, but repeat reads of Clients/AgencyClients timed out; official indexed responses supplied their schemas.

Validation: tests are written, not run by dispatch rule. Only one final package typecheck is authorized. Coordinator owns fixture execution, builds, lint and om:check. Runtime self-validation and coverage measurement are not run under this restriction.

## R2 integration contract and continuation

`translateCampaign({campaign, target, resolved})` accepts traffic, one creative, explicit `target.weeklyBudget` and country-to-region metadata. Daily budgets, search terms, other timezones, partial Moscow days, templates and excess copy are unsupported. Minor units convert exactly to safe integer micros; no daily ×7 conversion. `campaignDeploymentPlanSchema` closes the full identity/currency-bound hierarchy for the existing grouped card.

`deployCampaignPaused({context, operationId, plan, dependencies, checkpoint}, {signal})` uses the read adapter dependencies except `gateway`; inject the host's guarded fetch. It verifies ClientId/Login/Currency, creates campaign → group → responsive ad, and persists dispatch intent/returned IDs with the existing jobs checkpoint ABI. The host must atomically reject duplicate step intents across restart, recheck card/connection/scope/login/halt after every credential lookup, and hold its authority fence through each fetch. No second policy, card or outbox is added.

The plan explicitly requests DRAFT. Yandex's add schemas have no writable Status: documented creation stays DRAFT until moderation. No moderation/resume/suspend call is sent. Campaign/ad reads must show DRAFT and OFF; parent IDs, strategy, exact weekly budget/dates/timezone, regions, retargeting and responsive content must match. Search is WB_MAXIMUM_CLICKS; Network is explicitly SERVING_OFF. Every parent is read before its child; final reads verify the entire hierarchy. At most ten calls (three creates, seven reads), individually capped at 15 seconds/1 MiB; zero retries.

`readCampaignDeployment({...input, references})` reads saved IDs only using POST bodies with `method:"get"`. It never retries creates, matches names or resumes a partial sequence. Unknown receipts retain IDs even when a checkpoint fails or AddResults includes errors. A later read cannot supply a missing ID. Checkpoint evidence is authoritative; observer events contain only operation/correlation/trace/run metadata.

Schedule caveat: [Campaigns.add](https://yandex.com/dev/direct/doc/en/campaigns/add) says EndDate ends at 00:00 UTC+3, while the [UI help](https://yandex.com/support/direct/en/campaigns/campaign-dates) says 23:59 on the end date. Fixtures follow the API reference: both bounds are exact UTC+3 midnights, EndDate equals the exclusive neutral end date. This discrepancy needs vendor/browser acceptance before production exposure; no live acceptance is claimed.

NEEDS integrator: weekly neutral input and matching exposure currency, production metadata resolution, grouped-card/outbox/guarded-fetch binding and draft projection; shared composition/build/dependency/coverage wiring stays separately owned. DS2: weekly cadence and DRAFT presentation on existing surfaces. Conversions and browser OAuth remain deferred. Next: Coordinator runs written fixtures and real host shared dispatch acceptance, lint/build/om:check after shared work settles.

R2 manual architecture audit: PASS for lane/import/ownership/injected-I/O rules; integration/runtime evidence remains pending. Scope: only approved plugin files; no existing tests weakened. Public schemas/functions/types are documented; trivial private date/receipt helpers inherit their callers' contracts. Reuse: OM contracts/Zod/Node; LinkedIn checkpoint/readback style, separate Yandex codecs because JSON services, identity and responsive fields differ. No shared implementation owner was replaced.

| Assessment units | Disposition | Evidence / local correction |
| --- | --- | --- |
| Translation/schema/checkBinding/date/copy rules | INCONCLUSIVE | Literal wire expectations; unsupported cadence/timezone, exact money, duplicated regions and creative mismatch fixtures. Runtime/coverage unmeasured. |
| Deployment/checkInput/createStep/checkpoint/payload/receipt | INCONCLUSIVE | Snapshot, scope/admission, all dispatch/ack failures, retained IDs and repeated-intent fixtures. Separated credential checks and retained IDs before error interpretation. |
| Read/reconcile/readStep/verifyAccount | INCONCLUSIVE | Parent/status/budget/date/content drift; known-ID recovery only. Host binding and schedule semantics need acceptance. |
| send/checkCredential/decodeResponse/observe | INCONCLUSIVE | Revocation/expiry/cancellation, malformed/oversized responses, injected fetch/body deadlines and redaction fixtures. Host audit remains authoritative. |

Manual second pass checked variable meanings, parent ordering, reference retention, integer conversion, scope binding and secret redaction. No unresolved High/Critical semantic finding identified; lint/runtime/coverage evidence is unavailable under this run's restrictions. No certified spec hash or suite was supplied; these are new fixture tests, not certified acceptance evidence. No test/build/install/om:check or live vendor effect was run.

R2 final lane typecheck: `corepack pnpm run typecheck` from this package directory passed (exit 0), run exactly once. Tests remain written, not run. Remaining edits after that command record its result only.

Final R1 typecheck: `corepack pnpm run typecheck` from this package directory — PASS, exit 0, run exactly once on 2026-10-24 (source and fixtures included). No tests, builds, installs, om:check, indexing, live vendor calls, commits or pushes performed. Remaining edits after that check only recorded this result in documentation.

Reuse: public OM contracts own values, context, outcomes and effects; Zod/Node own validation, bounded streaming and hashing. LinkedIn package/transport/report/dispatch fixtures supplied style; separate codecs are necessary for Yandex's JSON envelopes, Client-Login binding, inclusive calendar days and TSV micros. No sibling implementation imports. All new public interfaces and meaningful effect/validation functions are documented; trivial private formatters inherit their caller's contract.

## Implementation review and continuation

Manual architecture audit: PASS within the R1 folder. Public-only OM imports, injected I/O/time, pure codecs, server policy ownership, no startup/registry/store, strict boundaries and no write capabilities checked. Governance ADR index and project_memory.md were absent; the approved review and target architecture supplied the applicable rules. No certified suite/hash was supplied; fixtures are newly written, not certified acceptance evidence.

| Assessment unit (including helpers) | Disposition | Evidence / local correction |
| --- | --- | --- |
| Command schemas, encodeCommand/request, decodeList/checkList/pageInfo/failure | INCONCLUSIVE | Direct fixture assertions for wire bytes, scope, IDs, malformed/duplicate pages and continuation. Extracted page metadata to keep branching bounded; runtime/lint evidence pending. |
| Report schema, encodeReport/columns, decodeReport/decodeRows/rowMatches/invalid | INCONCLUSIVE | Direct fixtures for exact micros/date provenance, both views, duplicate/foreign rows and caps. Separated metadata from atomic row parsing; runtime/lint evidence pending. |
| Factory/invoke, prepare/boundInput, dispatch/execute, send/httpFailure/readBody/decode/observe | INCONCLUSIVE | Fixture assertions cover post-token authority/admission/cancellation/expiry, repeated execute, streamed overflow, malformed/error responses, exceptions and redaction. Runtime/lint evidence pending. |

Coverage-friendly seams: every decision is reached through direct adapter inputs and injected credentials/gateway/fetch/clock/observer; no global mocks or hidden state. Native fetch and zero-argument gateway callbacks retain documented foreign ABIs. Adversarial invariants: one invalid/foreign/duplicate row rejects the entire page; revocation after token lookup prevents network; repeated execute sends once. No unresolved Critical/High semantic finding identified manually; mechanical complexity and runtime evidence remain unavailable under the run restrictions. Variable-name and edge-case skepticism pass checked ID/login separation, currency/micros, date boundaries, full-page incompleteness, redaction and current-authority ordering. Coverage is unmeasured; fixtures must run before acceptance.

Current objective at handoff: R1 implementation only. Next actions: integrator wiring and shared suite against real host bindings, Coordinator fixture/lint/build checks, then separately assigned R2. No speculative layer, runtime.json, conversion or draft exports were added. No shared file was edited and no existing test was weakened.
