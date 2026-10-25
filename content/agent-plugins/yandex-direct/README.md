# Yandex Direct — R1 reads/auth

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

R1 advertises only reads. R2 owns draft translation/deployment and is blocked from production exposure pending weekly-budget support and account/login, region, creative, currency and schedule resolution. No write, spend, activation, moderation, upload, keyword mutation, halt backend or conversion capability exists here. Metrica conversion upload is documented but explicitly deferred pending owner ratification; absence of a conversion capability is intentional. No runtime.json, registry, scheduler, vendor SDK, Jini dependency, shared-file edit or migration.

NEEDS integrator: add catalog/factory/schema exports and accountless discovery to `apps/server/src/composition/agent-plugin-backends.ts`; bind paste-token credentials/current admission/gateway/guarded fetch, verified account/login/currency and host rate limiting; add root `om:build-plugins`, dependency/lock wiring and `om-tool-coverage.ts`; instantiate `tests/contract/dispatch-suite.ts` against server bindings and extend server tests. DS2 owns existing connection/report presentation; HTTP/studio/CLI/assistant exposure is not delivered by this folder. Reuse exact pins in package.json; no install was performed. Coordinator must verify pending npm metadata for TypeScript/Vitest/Node types before dependency wiring.

Research is documentation evidence, not live vendor acceptance. See `io.github.ainsep.openmarketing/evidence/primary-sources.json` for quotes, consumed fields and blocked pages. The API's documentation is reachable, but repeat reads of Clients/AgencyClients timed out; official indexed responses supplied their schemas.

Validation: tests are written, not run by dispatch rule. Only one final package typecheck is authorized. Coordinator owns fixture execution, builds, lint and om:check. Runtime self-validation and coverage measurement are not run under this restriction.

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
