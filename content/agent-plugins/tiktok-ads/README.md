# TikTok Ads Agent Plugin

Server-loaded, inert Agent Plugins 1.1.0 package. After addons/assistant integration and host admission, the assistant can read the configured advertiser, create disabled website traffic campaigns/groups/single-video ads, activate or pause one entity, and retrieve account spend. Signup/trial conversions and campaign halt are typed server operations, never agent tools.

**Current state:** implemented against synthetic fixtures; `enabled:false` and every capability `admitted:false`. This package is outside OM workspace globs. No server integration, authenticated vendor calls, spend, migrations, installs, commits or pushes were performed.

## Operator flow

1. Connect a TikTok for Business advertiser through the server Integrations flow. Addons stores the access token and binds `advertiser_id`; it enumerates authorized advertisers at connect time. The token never becomes an assistant/tool argument.
2. Ask the assistant to inspect campaigns or build a website traffic ad. Create campaign, group and ad separately; each is a normal write with explicit `operation_status: DISABLE`. Group input includes existing campaign/location IDs, daily budget and account-local start time. Ad input uses existing video and AUTH_CODE identity IDs, text and an HTTPS landing page. No media upload or automatic hierarchy orchestration.
3. Each creation performs one POST and one filtered GET through the ONE server gateway. Only exact matching IDs/account and DISABLE readback prove the entity's operational status. If the check fails, the error names the known target; inspect it and explicitly ask to pause. The plugin leaves it untouched and never auto-pauses/activates.
4. Activation uses `ad_spend`: the existing server exact card is required for **every** call. Existing `moneyExposure`/`requiredLimit` fields come from the request; there is no additional plugin evidence gate. Pause is a normal write. ENABLE readback describes the entity's operational flag, not effective hierarchy serving.
5. Reports cover at most 31 inclusive account-local dates, with at most 100 rows/page. Host-verified account currency/exponent/timezone are required by `decodeTikTokReport`. Partial/empty reports have no complete spend total. Platform-attributed conversions never become OM CAC.

## Server composition

The public package surface is `io.github.ainsep.openmarketing/src/index.ts` (built import: `dist/index.mjs`). Constructors perform no I/O. Required injected boundaries:

- `createTikTokAdsAdapter({ binding, gateway, clock, observer })`. Binding fixes scope, connection, advertiser and installed plugin digest. `invoke({ context, operationId, command, moneyExposure, requiredLimit }, options?)` validates a closed command, derives trusted effects and passes it to the ONE server dispatcher. `tiktokTools` exposes ten input schemas/effects/fingerprints for the assistant catalog.
- `createTikTokFetchEgress({ fetch, credentials, observer })`. `credentials.access({ context, connectionId, accountId }, options?)` resolves the token at call time. Egress checks the live host `isCurrent` fence before lookup and again after it, immediately before fetch. Credential ports must honor the supplied deadline. All URLs are fixed TikTok v1.3 endpoints; no redirects/retries, a 15-second deadline, and a streaming 1-MiB response cap.
- `adapter.stop({ context, permit }, options?)` accepts a closed `HaltStopPermit`, bound to `tiktok-ads.stop.v1`. Campaign IDs are decimal strings, unique, at most 100. Its constant DISABLE batch is `halt_stop` with no money authority. The gateway must validate the CURRENT local halt ID/epoch, permit expiry, scope/account/plugin and existing campaign ownership under its halt fence. It sends one status POST and a single filtered readback; it never clears local halt.
- `createTikTokEventsBackend({ configuration, authority, egress, clock, observer })`. Deliver accepts `{ context: ServiceContext, event, grant, deliveryId }`. Configuration binds connection, advertiser, pixel code, plugin digest, destination, purpose, payload schema and production-server mode. Authority must validate live host admission, exact pixel/payload, current consent/grant and durable delivery claim/audit, then call `execute({ isCurrent })` at most once. The same credentialed transport carries Events egress.

Gateway calls contain token-free commands, `argumentsDigest`, installed digest and schema fingerprint. The normal digest is the canonical, key-sorted SHA-256 of encoded GET parameters or POST body, matching safety's canonical JSON convention. The halt digest instead uses safety's `{ adAccountId, entityIds, action }` identity and carries the original typed permit. The host re-encodes and verifies these values; it must not trust plugin or vendor annotations to grant authority.

The gateway returns bounded `{ code: 0, data: {...} }` envelopes. Create ID receipts are fixture-labelled `campaign_id`, `adgroup_id`, or single-element `ad_ids`. Reads strip unrequested fields. Writes distinguish unknown receipts from verified operational readback; post-create failure is explicit and does not trigger a corrective write. Telemetry includes correlation/trace/run IDs when present, never payloads/tokens/vendor error text. The server owns durable audit.

## Conversions, idempotency and uncertainty

Contacts is the only normalizer/hasher. Event identifiers accept lowercase 64-character SHA-256 `email`, `phone`, `external_id`, with at least one digest, plus captured HTTPS `event_source_url`. Raw/mixed-validity/uppercase identifiers and extra fields fail atomically. The backend does not hash supplied digests. `subjectId` stays server-side.

Signup maps to `CompleteRegistration`; trial to `StartTrial`. One web event per POST carries the configured pixel, original OM event ID, captured page and occurrence time **in Unix seconds**, explicitly floored from OM milliseconds. Seven-day maximum event age is an OM cap. The measurement service must adapt its open definition IDs into the shared signup/trial grant and retain the same event ID for browser/server channel dedupe.

Stable `operationId`/`deliveryId` binds one exact request in the server's existing jobs outbox. Domain intent/enqueue and claims remain server-owned; this plugin adds no outbox/store/registry. No vendor idempotency guarantee is assumed and no `request_id` is manufactured as a dedupe key. Network loss or malformed write acceptance stays `unknown`; never blindly retry. Events HTTP success plus code zero indicates acceptance, **not** attributed conversion proof. `reconcile` validates input and returns `unknown` without sending or resolving credentials because no verified per-event reconciliation endpoint exists.

## Official evidence

Version exception review **2026-10-24**: retain the following paths under `/open_api/v1.3/`. The [Marketing v2.0 inventory](https://business-api.tiktok.com/portal/docs/api-reference/v2.0) and [incremental migration guide](https://business-api.tiktok.com/portal/docs?id=1835052398174274) did not expose readable endpoint contracts during review; absence from an incremental guide does not establish lack of support.

| Existing paths | Reason for retaining v1.3 |
| --- | --- |
| `campaign/create/`, `adgroup/create/`, `ad/create/` | v2.0 creation fields/statuses and finite budget/schedule compatibility unverified. |
| `campaign/get/`, `adgroup/get/`, `ad/get/` | v2.0 scoped configuration/status readback unverified. |
| `campaign/status/update/`, `adgroup/status/update/`, `ad/status/update/` | v2.0 disabled-status request/response semantics unverified. |
| `advertiser/info/` | v2.0 advertiser schema unverified. |
| `report/integrated/get/` | Synchronous v2.0 contract unreadable; [async migration](https://business-api.tiktok.com/portal/docs/create-an-asynchronous-report-task/v2.0) does not verify synchronous fields. |
| `event/track/` | Events API 2.0 is distinct from Marketing v2.0; its existing transport remains unchanged. |

Grouped TikTok deployment remains typed unsupported pending complete official group/ad budget, finite schedule, timezone and disabled readback evidence. No executable changes or admission changes are made by this review.

Inspected **2026-10-13**, Marketing API **v1.3**, Events API **2.0**. Full field-by-field URLs, selected fixture enums, inspection dates and UNVERIFIED limitations live in [primary-sources.json](io.github.ainsep.openmarketing/evidence/primary-sources.json). Vendor publication dates are unavailable unless recorded there. Most portal bodies require JavaScript; TikTok-owned SDK docs and official indexed portal snippets supplement them.

| Operation | Official portal | TikTok-owned SDK fields |
| --- | --- | --- |
| Campaign create/get/status | [Create](https://business-api.tiktok.com/portal/docs?id=1739318962329602), [Get](https://business-api.tiktok.com/portal/docs?id=1739315828649986), [Status](https://business-api.tiktok.com/portal/docs?id=1739320994354178) | [Campaign model](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/CampaignCreateBody.md), [status model](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/CampaignStatusUpdateBody.md) |
| Group create/get/status | [Create](https://business-api.tiktok.com/portal/docs?id=1739499616346114), [Get](https://business-api.tiktok.com/portal/docs?id=1739314558673922), [Status](https://business-api.tiktok.com/portal/docs?id=1739591716326402) | [Group model](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/AdgroupCreateBody.md), [status model](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/AdgroupStatusUpdateBody.md) |
| Ad create/get/status | [Create](https://business-api.tiktok.com/portal/docs?id=1739953377508354), [Get](https://business-api.tiktok.com/portal/docs?id=1735735588640770), [Status](https://business-api.tiktok.com/portal/docs?id=1739953422970882) | [Ad body](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/AdCreateBody.md), [creative fields](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/AdcreateCreatives.md), [status model](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/AdStatusUpdateBody.md) |
| Advertiser/report | [Advertiser](https://business-api.tiktok.com/portal/docs?id=1739593083610113), [Report](https://business-api.tiktok.com/portal/docs?id=1740302848100353) | [Account API](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/AccountManagementApi.md), [Reporting API](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/python_sdk/docs/ReportingApi.md) |
| Events | [Parameters](https://business-api.tiktok.com/portal/docs?id=1771100865818625), [Delivery/acceptance](https://business-api.tiktok.com/portal/docs?id=1771100779668482), [standard event codes](https://ads.tiktok.com/resources/help/article/standard-events-parameters) | Official portal search results confirm seconds, required web page, dedupe identity and accepted-request receipt. |

**UNVERIFIED:** accepted traffic/identity/status combinations, live create/readback shapes, reporting precision/timezone semantics, exact OAuth scopes/token lifetime and Events pixel/account eligibility. Field presence alone establishes none of these. The existing host admission gate stays false; there is no redundant per-plugin UNVERIFIED availability switch. Per-call validation rejects missing/mismatched outcomes.

## Deferred integration and verification

Addons/Coordinator owns server gateway, credentials and conversion authority adapters, connect-time advertiser enumeration, plugin build/loading and grant/job/audit/measure binding. Assistant owns catalog exposure and HTTP/studio/CLI/OM MCP parity. No shared manifests, lockfile, contracts or composition were edited; no new dependencies are needed. Existing pinned tools come from root; the plugin remains a non-workspace package.

Written suites are `tests/contract/gateway.test.ts`, `events.test.ts`, existing `transport.test.ts`, and updated `manifests.test.ts`; fixture support is solely `tests/fixtures.ts`. Memory and injected-fetch egress use the same contracts. Gateway/consent/outbox are explicitly host doubles; Coordinator must run the exported gateway suite against the real server gateway and verify the conversion authority adapter. No runtime/shared-port certification is claimed. Tests, builds, om:check and coverage were **not run**, as dispatched. The lane runs only `corepack pnpm exec tsc --noEmit -p content/agent-plugins/tiktok-ads/tsconfig.json` once at handoff.

R2 typecheck: that exact command ran once using installed root TypeScript and exited **2**. It reported two TS2352 errors in intentionally invalid fixture inputs (`events.test.ts` and `transport.test.ts`), with no source errors reported. Both fixture casts were changed to explicit `unknown` boundary casts. The command was **not rerun** under the one-typecheck instruction; the final edited tree has no passing typecheck claim. No install was needed. Coordinator must rerun typecheck with the written suites during integration.

Architecture self-audit: package-only contracts import; no feature/policy/sibling-source dependency; no credentials or vendor configuration in the agent; all I/O injected; pure schemas/mapping separate from gateway/transport effects; no retries/local persistence; typed backend-only halt/conversion; normal writes and exact activation separated. Public interfaces and non-obvious bounds/uncertainty are documented inline. Mechanical complexity/nesting checks and runtime self-validation are deferred under the no-checks dispatch override.

| Assessment unit | Disposition | Evidence or remaining limitation |
| --- | --- | --- |
| Command/effect mapping, canonical digests | INCONCLUSIVE | Closed fields and independent exact-digest fixture assertions written; tests not run. |
| Adapter preparation/dispatch/readback, halt mapping | INCONCLUSIVE | Scope/status/partial-readback/duplicate-claim/permit tests written; real server gateway pending. |
| Events preparation/grant binding/delivery/reconciliation | INCONCLUSIVE | Digest/seconds/age/consent/uncertainty tests written; real authority pending. |
| Credentialed transport encoding/fences/receipts | INCONCLUSIVE | Shared memory/fetch contracts and existing stream/cap tests written; tests not run. |

Author review extracted effect preparation and HTTP response handling to keep control flow small. No known Critical/High source finding remains; mechanical metrics and runtime behavior are unverified. Second-pass review covered variable meaning, extra fields, cancellation after handoff, partial reads, repeated claims and consent withdrawal. Risk comes from missing execution/real-host/vendor evidence; do not interpret the static review or typecheck as production readiness.
