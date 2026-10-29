# LinkedIn Ads — R1 + R2

Server-loaded Agent Plugins 1.1.0 package, mirroring OM Meta Ads. Once addons and the assistant wire it in, an owner can ask the assistant to inspect accounts, prepare campaign groups as DRAFT, create Sponsored Content campaigns and existing-post creatives as PAUSED, activate one entity, change a campaign daily budget, or pause a campaign. Installation is separate from host admission; this package ships disabled and unadmitted. It is outside the workspace glob.

The package contains sixteen tools, a typed campaign halt-stop backend, and a server-job conversion backend. R2 adds analytics, conversion-rule setup and lead-form listing. There is no media upload, organic publishing, destructive tool, arbitrary HTTP, vendor SDK, registry, OAuth store or second outbox.

## Host entry and contracts

The sole public entry is `io.github.ainsep.openmarketing/src/index.ts`. Factories and imports are inert. The distribution entry is declared; no distribution was generated in either run.

```ts
const adapter = createTools({
  configuration, credentials, fetch: serverFetch, clock, observer, wait,
});
const result = await adapter.invoke({
  context, connection, name: "list_campaigns", operationId: "durable-server-operation",
  input: { kind: "list_campaigns", ids: ["567"] },
  moneyExposure: null, requiredLimit: null,
}, { signal });
```

`configuration` is exactly `{ scope, connectionId, accountId, pluginDigest, settings }`; account currency is read from authenticated metadata and API version 202610 stays plugin-owned. Tokens are requested at call time through `credentials.access({connectionId, accountId})`, returning `{accessToken, expiresAt?}`. The server checks scopes/roles, resolves refresh and keeps secrets out of the agent. Expiry is epoch milliseconds when supplied.

The internal `gateway.dispatch` carries `context`, `configuration`, `operation`, the exact serialized `request`, canonical `EffectEnvelope` and `execute`; the public fixed tools use host-guarded fetch. Resolve credentials first, then recheck current admission, connection, account/parent ownership, mode, halt and approvals at this gateway. Hold the server fence through `execute`, with no await gap after the final check. Every activation and budget call requires its own exact spend card. The server supplies `moneyExposure` and `requiredLimit` from the reviewed request; the plugin adds no evidence gate. Currency amounts are decimal strings with no invented minor-unit conversion or guaranteed hard-cap claim.

The host owns the ONE durable jobs outbox. Bind `operationId` to `argumentsDigest`, atomically claim before dispatch, reject changed arguments and never send an existing dispatched claim again. Append audit with operation/run/correlation/trace IDs. The digest covers the version and exact URL/method/body. The canonical halt capability retains safety's `{adAccountId, entityIds, action}` digest and emits only the mapped PAUSED request. No invented vendor idempotency header or reconciliation endpoint is used.

`createCapabilities(dependencies)["campaign.halt-stop.v1"]({ context, connection, input: permit.request })` accepts one campaign ID per canonical `HaltStopRequest`. Both `pause` and `stop` map only to a PAUSED campaign patch. The plugin checks scope, connection/account, plugin/binding and digest; the host checks permit expiry and live halt authority. It is not an assistant tool.

`tools` exports JSON Schema descriptors including the literal `kind`; `parseTool` retains the strict Zod command validation. The adapter always executes refinements, including group end dates with total budgets. List commands accept optional unique `ids`, `pageSize` (default/max 100) and opaque `pageToken`. Every invocation makes at most one 15s vendor call: 64KiB input/request, 1MiB streamed response, zero retries and no redirects. URLs are fixed in the codec; provider links are discarded. Caller cancellation reaches fetch.

A 201 + validated ID acknowledges campaign/creative creation; 204 acknowledges a patch. Neither implies observed serving state. Lists expose validated provider fields with source account checks; they never assert a complete paused hierarchy. Group create ACK syntax is UNVERIFIED in the inspected group documentation: the DRAFT request is sent, its receipt stays unknown, and a separate list readback must resolve it. Never resend an unknown write.

## R2 analytics, conversion setup and form metadata

`report` takes `pivot: ACCOUNT | CAMPAIGN` and `window: {start, end}` in epoch milliseconds, aligned to UTC midnight with an exclusive end (maximum 366 days). CAMPAIGN requires 1–100 unique `campaignIds`; ACCOUNT uses the configured account. It requests one ALL aggregate per pivot with explicit `dateRange,pivotValues,costInLocalCurrency,impressions,clicks` fields. Reports return source `linkedin_ad_analytics`, version/account/currency, injected retrieval time, the requested window and validated rows with their actual half-open windows. Spend stays a decimal string: no summation, floating-point rounding, FX or inferred hard cap.

LinkedIn analytics has no pagination. The plugin rejects over 100 rows and duplicate/foreign pivots atomically. Empty rows are labelled `no_data_access_unconfirmed`, never zero spend. Older ALL queries can expand to month boundaries; expanded responses reject rather than being attributed to the requested period. Shorten the period or use full months in a new explicit read.

`list_conversion_rules` retrieves owned rules for the configured account, with a 100-row response cap and no undocumented paging parameters. It projects rule ID/name/type/method/enabled/ownership. It does not assert that a returned rule is ready for event delivery; the host verifies an enabled, account-owned CONVERSIONS_API rule when resolving backend mappings.

`create_conversion_rule` takes a name, type (`LEAD`, `SIGN_UP`, `START_TRIAL`, `PURCHASE`, `OTHER`), explicit post-click/view-through windows (1, 7, 30 or 90 days), and attribution model (`LAST_TOUCH_BY_CAMPAIGN` or `LAST_TOUCH_BY_CONVERSION`). It forces `conversionMethod: CONVERSIONS_API`. Optional `autoAssociationType: OBJECTIVE_BASED | ALL_CAMPAIGNS` associates existing campaigns; ALL_CAMPAIGNS is vendor-limited to 200. `associate_conversion_rule` links one rule ID to one campaign ID through a compound-URN PUT. Both are normal writes under the one server policy; neither can activate campaigns. A 201 + validated rule ID or 204 association ACK does not prove attributed conversions.

`list_lead_forms` returns only account-owned form ID/name/state/version/owner metadata. It accepts `start` (0–1,000,000) and `count` (1–100, default 100). A full page returns a bounded `nextStart` hint for another explicit call; provider links are discarded. Form content, hidden fields, lead responses, downloads and webhooks are outside scope. Unsafe numeric JSON IDs reject; use decimal-string form IDs when they exceed JavaScript's safe integer range.

## Server-job conversion backend

```ts
const backend = createConversionDelivery({
  configuration: pluginConfigurationSchema.parse({
    scope, connectionId, accountId: "123", pluginDigest,
    settings: { conversionConfiguration: {
      accountId: "123", purpose: "measurement", payloadSchema: "om.conversion.v1",
      conversionRules: { signup: "urn:lla:llaPartnerConversion:789" },
    } },
  }),
  authority: conversionAuthority, credentials, fetch: serverFetch, clock, observer, wait,
});
const receipt = await backend.deliver({ context: serviceContext, event, grant, deliveryId });
```

This is not an assistant/MCP tool. `event` uses measure's open `definitionId`, shared `eventId`, subject, occurrence milliseconds, destination/purpose, `identifiers: {email}` and committed `identifierDigests: {email}`. `identifiers.email` must already be contacts' lowercase 64-hex SHA-256 destination email digest. The committed digest is contacts' internal evidence; it is not substituted as the vendor identifier. The backend never normalizes, hashes or accepts raw PII, phone/click IDs, userInfo or external IDs. Conversion values/order references and other identifiers are deferred.

The grant mirrors measure's `definitionIds` model with scope, connection/account, destination/purpose, payload schema/version, expiry and revocation. Configuration supports at most 100 definition-to-rule URN mappings. Reject unmapped definitions, foreign scopes/bindings, non-production mode, future events and occurrences older than 90 days before credential lookup; check age, grant expiry and token expiry again at fetch.

Credentials resolve first through the same `credentials.access({connectionId, accountId})` seam as interactive tools. `authority.dispatch` then receives the original parsed event, actual vendor payload, grant, configuration and durable `deliveryId`. The server MUST check CURRENT consent for the actual digest payload, current grant, connection, admission, rule ownership and production-server mode, verify committed identifier evidence, bind exact payload/version to the ONE outbox claim, and append pre-egress audit. Hold that authority fence through `execute({isCurrent})`; the synchronous final fence check occurs after token resolution immediately before POST. Duplicate callback execution is rejected locally; repeated/concurrent delivery IDs are claimed by the host, never by a plugin store.

Payload mapping is one event: `conversion`, `conversionHappenedAt` (unchanged milliseconds), `eventId` (unchanged OM ID), and `user.userIds[{idType: SHA256_EMAIL, idValue: contactsDigest}]`. A documented 201 means accepted delivery, not attributed conversion. Transport loss, malformed/oversized responses or ambiguous status returns `unknown` with zero retries. Definitive vendor 4xx returns a sanitized non-retryable typed failure. `reconcile` validates the request and returns unknown without credentials, authority dispatch or vendor I/O; no per-event readback endpoint is confirmed. Never resend an unknown delivery.

## Vendor evidence

Current request header and report provenance: **LinkedIn-Version: 202610**; **X-Restli-Protocol-Version: 2.0.0**. Migration checked **2026-10-24** against [October changes](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/recent-changes?view=li-lms-2026-10) and [creative schemas](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-creatives?view=li-lms-2026-10). Reads normalize `content.reference`, `content.standardUpdateAd.reference` and `content.videoAd.reference`; missing, malformed or conflicting references reject. Create requests stay unchanged. Deployment still requires matching account/campaign, DRAFT and non-serving evidence. Publisher-list `surface` enforcement starts in 202611; OM does not use publisher lists. No other listed breaking change touches OM's endpoints, fields or enums.

Stored 202609 conversion configurations must be explicitly refreshed; they remain denied until then. The tables below preserve endpoint documentation checked **2026-10-13**, view **li-lms-2026-09**; their dates are not refreshed by this migration.

| Tools | REST endpoint | Fields/scopes source |
|---|---|---|
| list_accounts | GET /adAccounts?q=search | [Accounts](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-accounts?view=li-lms-2026-09): search IDs, pageSize/pageToken, currency/status; r_ads or rw_ads |
| list_campaign_groups, create_campaign_group_draft, activate(group) | GET/POST /adAccounts/{account}/adCampaignGroups; patch /{group} | [Groups](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaign-groups?view=li-lms-2026-09): account/name, DRAFT, schedule, totalBudget, search, patch; r_ads/rw_ads |
| list_campaigns, create_campaign_paused, activate(campaign), set_budget, pause | GET/POST /adAccounts/{account}/adCampaigns; patch /{campaign} | [Campaigns](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-campaigns?view=li-lms-2026-09): account/group/organization, locale, schedule, bid, dailyBudget, targeting, politicalIntent, PAUSED/ACTIVE; r_ads/rw_ads |
| list_creatives, create_creative_paused, activate(creative) | GET/POST /adAccounts/{account}/creatives; patch /{encodedCreativeUrn} | [Creatives](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/account-structure/create-and-manage-creatives?view=li-lms-2026-09): campaign, content.reference, intendedStatus, criteria, serving state; r_ads/rw_ads |
| search_targeting | GET /adTargetingEntities?q=typeahead | [Targeting](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads/advertising-targeting/ads-targeting?view=li-lms-2026-09): facet/query/queryVersion, entity URN/name |

Reporting, conversion and lead-form calls now use **202610** headers. Their original endpoint evidence was checked **2026-10-13**:

| Operation | REST endpoint | Fields/scopes source |
|---|---|---|
| report | GET /adAnalytics?q=analytics | [Reporting](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting?view=li-lms-2026-09), [metric/date schema](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/ads-reporting-schema?view=li-lms-2026-09): account/campaign pivots, ALL, explicit fields, inclusive UTC dates, decimal cost; r_ads_reporting |
| list/create conversion rules, associate rule | GET/POST /conversions; PUT /campaignConversions/(campaign:URN,conversion:URN) | [Conversions API](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversions-api?view=li-lms-2026-09), [schema](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversions-api-schema?view=li-lms-2026-09): account/name/type/method/windows/model, autoAssociationType, rule IDs; rw_conversions + r_ads |
| backend deliver | POST /conversionEvents | Same [Conversions API](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversions-api?view=li-lms-2026-09) and [schema](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/ads-reporting/conversions-api-schema?view=li-lms-2026-09): conversion URN, milliseconds, 90 days, eventId, SHA256_EMAIL, 201; rw_conversions + r_ads |
| list_lead_forms | GET /leadForms?q=owner | [Lead forms](https://learn.microsoft.com/en-us/linkedin/marketing/lead-sync/leadsync?view=li-lms-2026-09), [schema](https://learn.microsoft.com/en-us/linkedin/marketing/lead-sync/lead-sync-schema?view=li-lms-2026-09): sponsored owner, count/start, ID/name/state/version; r_ads or rw_ads |

Targeting is limited to explicit geo IDs for campaign creation and documented typeahead facets for discovery. Unsupported fields and response shapes fail closed. Campaigns require a caller-supplied politicalIntent declaration; the host/assistant must present the documented EU advertiser notice where applicable. No declaration is fabricated by this plugin. Account/group/creative state and parent ownership are validated locally on reads and by the server before writes.

Every consumed endpoint/field/scope/header is listed in `io.github.ainsep.openmarketing/evidence/primary-sources.json`, with dates and limitations. [Rest.li encoding](https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/protocol-version) and [request methods](https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/methods) confirm value escaping and PARTIAL_UPDATE. Local resource caps are OM limits, not vendor promises. Capability fingerprints describe source compatibility; they are not a plugin allowlist or trust pin.

## OAuth handoff — addons owns it

Use LinkedIn's server-side 3-legged OAuth 2.0 flow, server-held client secret, state and redirect checks. Authorization is `https://www.linkedin.com/oauth/v2/authorization`, token exchange is `https://www.linkedin.com/oauth/v2/accessToken`. Access tokens are typically valid 60 days; honor returned expiry rather than hardcoding it. [Server code flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow) (unversioned, checked 2026-10-13).

Request `r_ads` for reading and `rw_ads` for mutations, plus the required product access/account roles from the endpoint sources above. Reporting requires `r_ads_reporting`; Conversions API setup and delivery require `rw_conversions` plus `r_ads`. Sponsored form metadata can use `r_ads` or `rw_ads`; no Lead Sync response-download scope is needed here. Refresh is only available to approved partners; reconnect if unavailable. [Refresh tokens](https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens) (unversioned, checked 2026-10-13). The generic OM PKCE adapter's provider binding is an addons NEED; this lane implements no OAuth flow.

UNVERIFIED: actual app access/account eligibility/OAuth binding, vendor mutation idempotency and per-operation reconciliation. Host admission defaults off; documented dispatch is available once the host admits it. Vendor 4xx becomes a typed non-retryable failure. Unknown writes remain unknown; no alternate active-create-then-pause workflow.

## Verification and handoff

All tests are fixture-only and **written, not run**. Existing campaign/stop/exact-card assertions remain; the tool-count/fingerprint assertions were updated for the approved R2 additions. No certified suite was supplied or weakened.

- `codecs.test.ts`: exact R1/R2 request mappings, inclusive/exclusive dates, compound URNs, auto-association and strict/bounded inputs.
- `dispatch.test.ts`: real plugin fetch edge over synthetic responses; source/decimal analytics, leap day, empty reports, foreign/duplicate/mixed-invalid/expanded pages, rule setup authority and ACKs, metadata-only forms and offsets. Existing R1 cancellation, expiry, byte limits, authority and exact-card tests also exercise the shared transport.
- `capi.test.ts`: unchanged digest/event/millisecond mapping, grant/mode/scope/age checks, consent withdrawal after credentials and at the final fence, malformed tokens, cancellation, duplicate/concurrent keys, uncertain delivery with no resend, redaction and no-I/O reconciliation.
- `contract/dispatch-suite.ts`: interactive and conversion authority acceptance suites. Memory host fixtures exercise the real plugin transport; addons must instantiate these same suites for its real authority/gateway adapters. Production-host B1 evidence remains deferred.
- `manifests.test.ts`: portable layout, sixteen tools, eleven unadmitted capabilities, backend-only delivery, declared effects, fingerprints and dated official evidence.

R2 typecheck: `corepack pnpm exec tsc --noEmit -p content/agent-plugins/linkedin-ads/tsconfig.json` ran exactly once from the repository root and passed (exit 0, no diagnostics), covering source and fixtures. Root TypeScript and existing dependency resolution were used; no install was performed. No tests, lint, build, install, om:check, live call, migration, commit or push ran. Runtime/coverage/mechanical complexity evidence is unavailable under the dispatch restrictions.

Architecture self-review: PASS for lane/public-import/ownership constraints, with runtime verification deferred. Only public @open-marketing/contracts imports; vendor code and config stay in this plugin; factories/imports are inert; I/O/time/observations are injected; one server policy/outbox/consent owner; no second approval or persistence mechanism; no shared-file edits. The approved R1 Meta/Google seed governs R2 style. No new ADR/spec/certification artifact or project-memory/governance index was available; the approved plan/review, owner decisions and target architecture govern this run.

Reuse: interactive and CAPI now call the same lane-owned token parser and bounded HTTP helper (two actual consumers). OM Meta supplied the digest-only backend and live authority fence pattern; Google supplied the injected token/fetch pattern. LinkedIn codecs remain separate because REST paths, version headers and compound URNs differ. Node/Zod and existing public contracts provide parsing/serialization. No sibling imports or new dependencies.

| Assessment unit (includes named helpers) | Disposition | Findings / local correction |
|---|---|---|
| R2 command schemas/policy/REST mapping | INCONCLUSIVE | Runtime/lint unavailable; exact wire and unsupported-input tests written |
| reportCommandSchema, encodeLinkedInReport, decodeLinkedInReport | INCONCLUSIVE | Runtime/lint unavailable; decimal/date/pivot/aggregate tests written; expanded periods reject |
| resolveCredential, requestLinkedIn, readBody | INCONCLUSIVE | Runtime/lint unavailable; shared existing tested seam used for both consumers |
| decodeResponse, decodeReportResponse, decodeWriteResponse, decodeLeadForms, listSchema | INCONCLUSIVE | Split analytics/entity/write parsing to keep decision paths small; metadata/paging/ACK tests written |
| createConversionDelivery, prepare, checkAuthority, grantMatches | INCONCLUSIVE | Runtime/lint unavailable; strict digest-only model and narrow open-definition grant tests written |
| CAPI dispatch, observe, reconcile | INCONCLUSIVE | Runtime/lint unavailable; post-token live fence, duplicate/unknown/redaction/no-I/O cases written |

Manual second pass checked variable names, byte/date/page bounds, current-authority ordering, stable wire bytes, exact identifiers and uncertainty. No unresolved Critical/High semantic finding identified; mechanical checks and executed tests are still required. Public and meaningful boundary functions document their behavior and costs; private leaf formatters inherit parent documentation. Function shapes use object parameters; library/host callbacks retain their documented ABIs. Coverage cannot be measured because suites are prohibited. Runtime self-validation was not run for the same reason.

NEEDS: addons binds credentials, gateway and conversion authority, verifies live OAuth/product/account/rule access, and runs the shared suites against real host adapters. Measure registers definition-to-rule mappings and projects only the supported email digest keys (value/orderRef and other identifier types reject). Assistant publishes all sixteen tools through HTTP/studio/CLI/OM MCP. Coordinator/TestRunner owns executed fixture tests, build and om:check. Conversion rates (600/min and 500k/day per token) remain server-owned. Plugin-local devDependencies are not installed; the successful typecheck used root TypeScript. NEEDS for standalone packaging: Coordinator installs the existing exact package pins when authorized (`typescript@5.9.3`, `@types/node@24.10.1`, `esbuild@0.25.12`, `vitest@3.2.4`, plus existing `zod@4.1.13` and public OM contracts resolution). No new dependency, shared manifest/lockfile/contract/composition edit or migration is requested by this lane.
