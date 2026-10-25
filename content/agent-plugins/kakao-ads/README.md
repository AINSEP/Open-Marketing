# Kakao Moment — R1 reads and pasted Business tokens

Lists accounts (ten per page), lists campaigns (local cap 1,000), and returns daily account BASIC reports. The package is disabled/unadmitted and awaits server integration; it is not yet available in OM's assistant, HTTP, CLI or studio.
After integration, paste a Business token into the existing Integrations flow; the approved Kakao Biz app needs moment_management. Bind the chosen account after discovery. No new credential storage or OAuth flow is included.
Examples: “List my Kakao ad accounts” and “Show Kakao performance for October 1–7”. Public factory: `createKakaoAdsAdapter({ configuration, credentials, fetch: guardedFetch, clock, createDeadlineSignal, observer })`; then `adapter.invoke({ context, operationId, command: { kind: "list_accounts", page: 0 } })`.
Reports use inclusive `start`/`end` in `yyyyMMdd`, <=31 days, excluding today/future dates in KST. Provider dates and empty metrics are preserved. BASIC covers documented Display metrics, not Message metrics; currency and finalized totals are not inferred. Results contain projected vendor fields, not raw payloads or tokens.
Official [accounts](https://developers.kakao.com/docs/en/kakaomoment/ad-account), [campaigns](https://developers.kakao.com/docs/en/kakaomoment/campaign), [reports](https://developers.kakao.com/docs/en/kakaomoment/report), [Business tokens](https://developers.kakao.com/docs/en/business-auth/common) and [KST support clarification](https://devtalk.kakao.com/t/default-timezone/151914) underpin the dated URL/quote evidence in `io.github.ainsep.openmarketing/evidence/primary-sources.json`.

## Integrator handoff

- Add catalog ID, descriptor conversion and invoke binding in `apps/server/src/composition/agent-plugin-backends.ts`. Inject configuration `{ scope, connectionId, accountId, admitted }`, existing `integrations.access` wrapper, clock/observer, guarded fetch and `createDeadlineSignal({ timeoutMs })`. The host can bind the latter to `AbortSignal.timeout(timeoutMs)`; fixtures use manual abort controllers. No gateway is added.
- Permit null account **only** for Kakao `list_accounts`, retaining scoped plugin/connection ownership. Other reads require the bound account. Recheck live admission and ownership after awaited credential access, at actual egress; append existing audit with run/correlation/trace IDs.
- Append Kakao to root `om:build-plugins`; resolve workspace/lockfile only if needed. Pins match LinkedIn; no install or shared edit was performed here.
- Consume `tests/contract/dispatch-suite.ts` from `apps/server/tests/agent-plugin-backends.test.ts` using the real host fixture. The lane consumes it with a synthetic broker; real-host B1 evidence remains pending.
- Record reporting availability and unsupported deployment in `apps/server/src/om-tool-coverage.ts`. DS2 owns all studio changes. Reuse existing generic HTTP/CLI/MCP surfaces.
- TestRunner must run fixtures, shared host suite, build and om:check after integration. This run writes tests only and runs one package typecheck. No live calls, migrations, commits or pushes.

## Limits and review notes

One fixed GET per call, no redirects/retries/automatic pagination; input <=64KiB, streamed response <=1MiB and a host-created 15s vendor deadline. 429 and documented 400/-10 become non-retryable limit_exceeded. The server owns admission, revocation, audit and token custody. Fetch must honor AbortSignal for pending fetch and body reads. Caller cancellation returns cancelled; deadline failure returns unavailable; neither retries. Factories perform no I/O or deadline creation.
Deployment remains blocked: create-time non-serving status for the complete hierarchy/schedules is unverified. OAuth loopback/refresh, conversion ingestion, idempotency and general sunset guarantees remain unverified; no capabilities depend on them.
Reuse: server integrations.access owns secrets/current connection; guardedFetch owns egress authority/audit. Public OM contracts supply context, clock, observer and outcomes; Zod validates Kakao projections. LinkedIn supplies package conventions only. No sibling plugin imports, runtime.json, SDK, charts, registry, scheduler or outbox.
Architecture audit: lane-only vendor adapter; public index exports; injected I/O/time; read-only effects; typed/redacted failures; no shared contract changes or migrations. Runtime/coverage evidence is pending because this dispatch forbids test/build runs.

| Assessed units | Disposition | Evidence / remaining finding |
| --- | --- | --- |
| factory, prepare, boundInput, execute, credential check, request/body/status mapping, observe | INCONCLUSIVE | Fixture assertions written; runtime evidence pending TestRunner. |
| command encoder, calendar/window guards, report/list decoders | INCONCLUSIVE | Boundary/mixed-invalid/duplicate/foreign-account tests written, not run. |

Documentation: public boundaries and non-obvious resource/ownership/date invariants documented. Static self-review checked names against computed values, redaction, empty metrics and bounded atomic projection; runtime correctness is not claimed.
R1F review fixes: deadline-signal creation is an explicit host dependency. Pending-fetch and pending-body fixtures wait for actual I/O before caller/deadline abort; assertions cover propagation, typed settlement, one request, redaction and body-reader release. The fixtures create no real timers. Tests were written, not run; real server authority/B1 integration remains pending outside this lane.
Reuse: searched om-clock and the LinkedIn transport for deadline signals/AbortSignal.timeout; used native AbortSignal composition with an injected creation function in the existing KakaoDependencies object. No shared package or timer abstraction was added.
R1F function assessment: request plus pending-I/O fixtures are INCONCLUSIVE pending runtime evidence; bounded O(1) signal/fixture setup, unchanged O(b) body limit. Static review checked signal ownership, variable meanings, settlement/error paths and lane boundaries. Documentation covers the new host dependency and pending integration.
Verification: R1F ran `corepack pnpm run typecheck` once in this package; exit 0. No tests, builds, installs or om:check were run. TestRunner owns runtime verification of the pending-I/O regressions and real server integration.
