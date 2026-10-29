# Reddit Ads — R1

Inert server-loaded Agent Plugins 1.1.0 package; disabled and unadmitted by default. Four closed read commands are declared: business discovery and provider reporting are implemented; account/campaign listing fail with `not_implemented` before credentials or egress until missing official v3 schemas are supplied. No server/UI/build wiring or distribution bundle is included in this run.

After the integrator connects the catalog, the owner can ask to list Reddit businesses or report account/campaign spend, impressions and clicks. Account listing excludes shared accounts when implemented. This is a partial R1 handoff, not a complete launch integration.

```ts
const adapter = createRedditAdsAdapter({ configuration, credentials, fetch: guardedServerFetch, createDeadline: ({ timeoutMs }) => AbortSignal.timeout(timeoutMs), clock, observer });
await adapter.invoke({ context, operationId, command: { kind: "list_businesses" }, moneyExposure: null, requiredLimit: null }, { signal });
```

The only public entry is `io.github.ainsep.openmarketing/src/index.ts`. Legacy adapter `configuration` holds `{scope, connectionId, accountId, currency}`; account/currency may be null only for discovery. The host's guarded fetch rechecks connection/plugin/account authority after its own awaits. Credentials are server-brokered via `access({connectionId, accountId}, options)`; require adsread and preserve server scope/plugin checks even with a null account. Imports/factories start no services. Canonical OM context/options/outcome/clock/observer contracts are reused.

Auth is paste-token only. After catalog integration, use the existing server CLI `om integrations connect --plugin reddit-ads --token-stdin`; never paste credentials into chat. Reddit returns 3600- or 86400-second lifetimes; the server may supply `expiresAt` in epoch milliseconds. Known expiry rejects locally; 401 means reconnect with a fresh token. Unknown expiry is not a lifetime guarantee. No automatic refresh, OAuth descriptor or O2 work is supplied; Ads loopback eligibility remains unverified.

Each explicit invocation fetches at most one page: pageSize defaults/maxes to 100, input/body <=64KiB, streamed response <=1MiB, host-created fetch deadline 15s, no redirects/retries. The required `createDeadline({timeoutMs})` dependency returns a fresh signal per request; the adapter passes 15000 and combines it with caller cancellation for fetch and response streaming. Deadline failures return sanitized `unavailable`; caller aborts return `cancelled`. Continuation links must match the current origin/path, contain only one page.token and optional unchanged page.size, and contain no credentials/fragment. Return nextPageToken/incomplete; the caller explicitly requests the next page. Unknown link formats fail closed.

`report` takes `{kind:'report', pivot:'ACCOUNT'|'CAMPAIGN', window:{start,end}, pageSize?, pageToken?}` with epoch-millisecond UTC midnights <=31 days apart. POST reporting remains read policy. The exact supplied UTC timestamps go to the provider; `windowBasis:'request_utc'` labels request boundaries without asserting unsourced end-inclusion semantics or neutral measurement coverage. Reports retain source/version/account/currency, retrieval time and optional provider metricsUpdatedAt. Spend stays exact safe integer microcurrency as a string; unsafe/fractional/negative values, foreign account/currency, duplicate pivots and incomplete malformed pages reject atomically. Null metrics stay null; empty means no data/access unconfirmed. No summation, FX, inferred zero or complete-page totals.

Numeric metrics require native JSON.parse source contexts, available in the current Node 24 host. Source lexemes must match their safe decimal integer exactly; fractional/exponent forms and unsupported engines fail closed rather than silently round source microcurrency.

Evidence with dated official URLs and short quotes is in `io.github.ainsep.openmarketing/evidence/primary-sources.json`. Business/report schemas were recovered from official search-index extracts; direct page extraction omits schema controls. OpenAPI download/DNS and full account/campaign schemas remain blocked. v3 is stable through Q3 2027; v4 preview schemas were not used. Fixtures do not prove vendor eligibility.

Handoff NEEDS: integrator adds an explicit Reddit branch in `apps/server/src/composition/agent-plugin-backends.ts`, descriptor conversion, guarded adapter/credentials binding, and the two null-account discovery exceptions. Add Reddit to root om:build-plugins and exercise `tests/contract/dispatch-suite.ts` through real host bindings in server tests. Keep blocked descriptors unavailable in host coverage. DS2 owns studio. Neutral measurement mapping is deferred. No new dependencies, contracts, workspace, lockfile, migrations or shared-file edits. Existing exact dependency pins match LinkedIn; no installation performed.

R2 PAUSED deployment, production account/creative binding, OAuth, conversions, activation/budget mutation, halt and destructive operations are deferred/omitted. Preserve sandbox-only campaign composition. Every future spend call retains the one exact server card rule.

Reuse: transport/package precedent inspected in LinkedIn src/{ports,commands,transport,reporting,index}.ts and server agent-plugin-backends.ts; canonical contracts and native fetch/URL/Buffer plus installed Zod implement this lane. Reddit owns separate codecs because its v3 envelopes, business discovery and read-only POST reporting differ. No gateway/registry/outbox is added.

Audit: lane/public-entry/DI/policy boundaries reviewed; no shared edits. Tests are written, not run by dispatch. Runtime self-validation and coverage measurement are not run for that reason. Function assessment is INCONCLUSIVE pending executed tests/lint: command encoding/pagination, report encoding/projection, preparation/credential dispatch, bounded fetch/JSON, page projection and observations each have direct fixture assertions. Second pass checked names, null/empty handling, duplicate rows, cross-account data, token leakage and bounds; no known Critical/High semantic issue remains. Public boundaries/schemas/types and security/I/O helpers are documented; trivial private failure constructors inherit surrounding docs. Native fetch, Zod and Vitest callbacks retain their library ABIs. Typecheck result is reported in the final handoff.

| Assessment unit | Disposition | Findings / local fix / direct evidence |
| --- | --- | --- |
| commandSchema, encodeCommand | INCONCLUSIVE | Missing vendor list evidence; pre-credential block and invalid-input tests |
| nextPage, sameResource | INCONCLUSIVE | No known semantic issue; hostile/duplicate/repeated/foreign link tests |
| report schema, encodeReport, decodeReport | INCONCLUSIVE | Unsourced end-inclusion stays request-labelled; exact wire, mixed-row, duplicate, null/empty tests |
| factory, prepare, sameScope, invoke | INCONCLUSIVE | No known semantic issue; shared dispatch, null binding, cancellation, revocation, expiry, snapshot tests |
| send, readBody, decodeJson, exactMetric, httpFailure | INCONCLUSIVE | Rounded-source hazard fixed with native source context; bounds/status/throw/fractional-source tests |
| decodePage, projectData, observe | INCONCLUSIVE | Split collection projection to reduce nesting; malformed pages, secrets and observer-throw tests |

Fresh requirement/scope review found no added write/deployment capability or tests weakened for coverage. Complexity was reviewed manually; lint, coverage and runtime checks were not executed. Tests remain unrun under dispatch; the integrator must execute the retained suites. Documentation classification: public/boundary symbols documented, trivial private failure constructors intentionally inherit adjacent contracts. Function-quality route remains INCONCLUSIVE, with no known unresolved Critical/High finding.

R1F review fixes: campaign reporting now has a shared-suite assertion on the outgoing `["AD_ACCOUNT_ID", "CAMPAIGN_ID"]` breakdowns. Deadline creation is injected rather than using a global timer inside the adapter. Fixture-controlled abort tests cover deadline cancellation with and without a caller signal, caller cancellation, sanitized outcomes and zero retries. The host integrator must supply `createDeadline` alongside guarded fetch; no shared composition file was edited. `send` remains INCONCLUSIVE until tests/lint are executed; the existing bounded streaming/status tests plus the new deadline tests directly cover it. Documentation classification: dependency and factory/send examples updated. No vendor schema or capability was added.

Verification: the R1 run recorded a passing `corepack pnpm run typecheck` on 2026-10-24. R1F's single permitted typecheck result is reported in the final handoff; tests, build, install, om:check, indexing, commit and push remain unrun.

R2 evidence-gate handoff (2026-10-24): PAUSED launch remains unavailable. The binding `ADS-memory/.local-artifacts/codex-runs/2026-10-24-plugin-reddit-ads/evidence-chrome.md` confirms official Postman examples, not complete required-field schemas. This run rechecked official v3 create/reference/setup pages; direct extraction still omits create schemas, the OpenAPI URL is inaccessible, shell download fails DNS, and Playwright access requires approval unavailable under the host's never-approval policy. No vendor/account calls were made.

Still needed before implementation: current campaign/ad-group/ad required fields and complete create acknowledgements; funding-instrument/pixel/post ownership contracts; exact country targeting, daily budget, CPC, timezone/schedule semantics; and readback contracts for the entire approved configuration. Some indexed GET fields were recoverable, but they do not establish the missing create contracts. Do not substitute v4, infer required fields from examples, or treat fixtures as vendor evidence.

The prior R2 run added no translation/deployment export, write descriptor or placeholder backend. The existing strict read boundary returns typed `invalid_input` before credentials/network for launch commands or launch fields smuggled into reads. `tests/campaign-deployment.test.ts` records those protections, repeated rejection with unchanged caller references, and a succeeding business read afterward. These tests are written, not run; they do not verify deployment, checkpoint ordering, readback or reconciliation. R2 is a blocked partial handoff.

Once evidence is supplied, implement only the approved one-traffic-campaign → one-ad-group → one-existing-post subset, with explicit PAUSED at every level, durable dispatch checkpoints, saved IDs and matching parent readback before each child. Unknown outcomes must retain refs and reconcile by saved-ID GETs only; never resend uncertain creates or add an idempotency header without vendor documentation. The integrator then binds it to OM's existing grouped exact card/outbox, preserving sandbox-only composition and denying direct deployment invocation. Production account/creative resolution and DS2 presentation remain separate NEEDS; conversions remain omitted. No shared files, dependencies, contracts or migrations changed.

R2 verification: exactly one `corepack pnpm run typecheck` from `content/agent-plugins/reddit-ads` passed (exit 0). Tests/builds/om:check/install/runtime validation were not run under dispatch. Scope audit: only this README, evidence JSON and the new deployment-boundary test changed; no production functions or existing tests changed. Function-quality assessment: not applicable to production code; test/runtime evidence remains INCONCLUSIVE until integrator execution. Reuse: existing real adapter plus per-test injected fixture; no new transport, policy or persistence. This is an evidence-blocked handoff, not completion of the R2 deployment goal.

R2F (2026-10-24): the planned public `translateCampaign`, `deployCampaignPaused` and `readCampaignDeployment` entry points now return non-retryable `unavailable`. `campaignDeploymentPlanSchema` rejects every input. These are explicit evidence denials, not a working deployment backend; no write tool is advertised. They do not traverse inputs, invoke checkpoints, access credentials or make requests. Reconciliation leaves caller-owned references untouched, including on concurrent/repeated calls, but cannot validate any prior uncertain create. The existing read commands keep their original contracts.

Official create pages were rechecked; schema controls remain absent in extracted text. OpenAPI retrieval again failed (web inaccessible, shell DNS failure); automatic approval review rejected browser navigation because host approval policy is `never`. Indexed GET campaign/group fields were recovered, but do not supply the missing complete create, ownership and configuration contracts. The binding Chrome examples remain examples. Evidence details are in `evidence/primary-sources.json` under `r2.fixRun`.

R2 review items 3 and 5 remain blocked for successful translation, three PAUSED creates, durable checkpoints, ordered matching readback and GET-only reconciliation. Tests now exercise the explicit unavailable entry points and zero checkpoint/credential/deadline/network effects; no test claims uncertain-create retention or vendor compatibility. NEEDS: official schemas listed above, then implementation and behavioral tests, followed by integrator binding to the existing grouped card/outbox. No dependency, manifest, policy, outbox, migration or shared-file changes.

R2F audit: PASS for lane isolation, sole public entry, canonical contracts and zero effects; R2 functionality remains blocked. Reuse: installed Zod `never` denies every plan and canonical `Outcome` represents denial; existing fixture dependencies assert absence of effects. Pattern follows existing object-input functions and typed failures. Public entry points/schema are documented. Function assessment: `translateCampaign/deployCampaignPaused/readCampaignDeployment/deploymentUnavailable | INCONCLUSIVE | official schemas and executed behavioral evidence missing | unconditional denial`. Each is O(1) time/space with no external I/O. Coverage and runtime self-validation were not run under dispatch. Scope/requirements/test-integrity review preserved R1 and all existing assertions; the single permitted R2F typecheck result is in the handoff.

Fix wave 2026-10-26: `createCapabilities` uses the contracts host ABI and catalog keys
`report.metrics.v1`/`campaign.status.v1`; canonical status uses only broker and host-guarded fetch,
without plugin admission hooks. Legacy `invoke` remains separate.
Canonical configuration is contracts `pluginConfigurationSchema`:
`{scope, connectionId, accountId, pluginDigest, settings}`. Install settings do not supply account
facts; a validated account GET supplies currency, the credential broker supplies the token.
Daily account/campaign metrics use explicit UTC, a 31-day window, and up to 50 bounded POST
report pages with at most 5,000 retained rows. Spend micros and counts stay exact integer strings; null, zero and unsupported
conversion metrics stay distinct. DATE suffixes are cut to ISO calendar dates. Duplicate/foreign
rows and conflicting currency reject the page atomically; a validated exclusive-end row is filtered.
Validated pagination tokens are followed on reconstructed account URLs with the same POST body;
request or row truncation returns `complete:false`. Unknown
coverage stays `dataThrough:0`, stale and provisional, including a valid empty response.
[Reddit reporting](https://ads-api.reddit.com/docs/v3/api/get-a-report) confirms UTC, spend units,
restatement and 24-month delivery history. The official extracted page omits detailed schema controls;
[Airbyte's connector source](https://raw.githubusercontent.com/airbytehq/airbyte/master/airbyte-integrations/connectors/source-reddit-ads/manifest.yaml)
verifies daily breakdowns, `data.metrics[]` and date truncation. Fixture regressions are written,
not run; vendor acceptance remains unverified. Legacy aggregate reports are unchanged.
