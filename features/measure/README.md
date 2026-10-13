# Measure

Public imports use `@open-marketing/measure`. Factories are inert; the server owns
all dependency construction, workers, credentials and network configuration.

Measure creates scoped HTTPS tracking links, accepts authenticated signup/trial
conversions once, commits each conversion with its job, and reports platform spend
against declared OM attribution. A separate typed server dispatcher verifies the
committed event and rechecks consent and the current measurement grant before
conversion delivery. Unknown or interrupted attempts reconcile without resending.

```ts
const receipt = await measure.ingestConversion({
  source: serverVerifiedSource,
  event: verifiedSignup,
});

const report = await measure.reportCac({
  context,
  query: {
    accountId: "account-1",
    attributionWindow: "30d_click",
    window: { start: periodStart, end: periodEnd },
    currency: "USD",
    timezone: "America/Los_Angeles",
    attributionModel: "last_touch_v1",
  },
});
```

`createMeasureService` retains the existing required dependencies. Supply its
optional `authentication` port for ingestion; absence denies authentication. The
adapter must bind actual server-authenticated request evidence to source scope and
revision. Matching a source ID in a registry is a test double, not authentication.
`jobs` and `conversions` remain compatibility dependencies: ingestion uses the
repository's atomic jobs binding; delivery uses the separate dispatcher.

`createSqlMeasureRepo({ database, jobs })` uses the injected portable OM DB shape.
The jobs adapter must enqueue in the **exact** supplied transaction and propagate
scope/correlation/trace. Serialize writers and roll back when work throws. Apply
both Measure migrations through the separately authorized server migration path.
Feature imports/factories never apply migrations or open databases.

`createConversionDispatcher` requires `verification`, `ledger`, `policy`, `grants`,
`delivery`, `audit`, `clock`, `runtimeMode` and `payloadSchema`. Bind verification to
`createSqlConversionVerification` over the ingestion DB. Use an always-on production
server, a jobs-owned stable delivery ID, durable ledger/audit, current grant and
connection authority, and typed plugin capabilities. Plugin code owns guarded HTTP,
credentials, provider normalization and reconciliation evidence. Register no
conversion dispatcher as an arbitrary agent tool. Cancellation prevents new egress;
evidence after possible egress is persisted even if the caller cancels.

Tracking requires an explicit destination-origin allowlist and base URL. UTM fields
are bounded; identifiers such as click IDs require explicit query-key admission.
Duplicate query keys, credentials, fragments, unknown keys and unsafe protocols
reject. Resolution checks the stored destination again. Measure collects no new
identifier and follows no external redirect chain.

Attribution records require a verified event, declared model, account and nullable
campaign mapping. Account-bound counts use `[start,end)` event time; unmapped events
are excluded. A correction uses a new model version and result ID. CAC validates
account, currency, timezone, period and platform attribution window, labels both
sources, and returns `null` for a zero denominator. The watermark is maximum observed
event time (window start when empty), **not** a completeness guarantee. Snapshots and
restatements append immutable evidence. Automatic touch-to-conversion attribution
and gap/completeness reporting need a future explicit contract.

Tests cover memory, SQLite and loopback HTTP capabilities with shared B1 suites.
They are written, not run under the owner's no-test override. The sole permitted
typecheck found the inherited SQL-boundary generic error; the explicit type fix has
not been rerun. See `HANDOFF.md` for verification status and integration needs.
