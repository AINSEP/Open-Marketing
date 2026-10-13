# Measure

Public imports use `@open-marketing/measure`. Factories are inert; the server owns
dependency construction, workers, credentials and network configuration.

Measure creates scoped HTTPS tracking links, accepts authenticated business
outcomes, commits each outcome with its job, and reports platform spend against
declared OM customer acquisitions. The typed server dispatcher verifies committed
evidence, resolves current identifiers, then rechecks consent and the current grant
before delivery. Unknown or interrupted attempts reconcile without resending.

```ts
const receipt = await measure.ingestConversion({
  source: serverVerifiedSource,
  event: {
    eventId: "purchase-1",
    definitionId: "purchase",
    subjectId: canonicalSubjectId,
    occurredAt: outcomeTime,
    destination: "account:google",
    purpose: "conversion_measurement",
    identifierDigests: contactsDigests,
    value: { minorUnits: 1299, currency: "USD" },
    orderRef: "order-123",
  },
});

const report = await measure.reportCac({
  context,
  query: {
    definitionId: "purchase",
    accountId: "account-1",
    attributionWindow: "30d_click",
    window: { start: periodStart, end: periodEnd },
    currency: "USD",
    timezone: "America/Los_Angeles",
    attributionModel: "last_touch_v1",
  },
});
```

`ConversionInput` is durable: canonical `subjectId`, stable business IDs and
`identifierDigests`, with optional `Money` value and opaque `orderRef`. Raw
`identifiers`, the closed `eventType` field and adjustment fields are rejected.
Digest maps accept at most 16 entries. Event/delivery identities are SHA-256 over
fixed tuples with sorted digest keys; transient identifiers and retry traces cannot
change identity. Contacts alone owns identifier normalization and hashing.

`createMeasureService` retains its existing dependencies. Supply its optional
`authentication` port for ingestion; absence denies authentication. The existing
`VerifiedConversionSource` / `ConversionSourceAuthenticationPort` seam must bind an
authenticated signed webhook or authorized operator to source scope/revision.
The source registry is a test double, not production authentication.

`createSqlMeasureRepo({ database, jobs })` requires transaction-scoped enqueue in
the **exact** supplied transaction, with scope/correlation/trace propagation.
Production jobs serialize source/event IDs and reload the committed event. There
is one jobs-owned outbox. Feature factories never open databases or apply DDL.
The initial `0001_measure.sql` now contains required typed event `subject_id` and
`definition_id`, delivery `subject_id` and `event_id`, and scoped lookup indexes
`(scope_key,subject_id,definition_id,occurred_at)` and
`(scope_key,subject_id,event_id)`. The fixture uses 0001 followed by existing 0002;
server migration registration/application remains an integrator operation.

`createConversionDispatcher` now also requires `identifiers`:
`ConversionIdentifiersPort.identifiersFor({ context, subjectId, destination, purpose })`.
Bind it to contacts in server composition. Missing/erased subjects, mismatched
subjects/digests, extra/missing identifier keys and malformed lookups deny dispatch.
Only transient `ResolvedConversionInput` reaches delivery/reconciliation; inbox,
ledger, audit and identity calculation never receive resolved identifiers.

The other required dispatcher dependencies remain `verification`, `ledger`,
`policy`, `grants`, `delivery`, `audit`, `clock`, `runtimeMode` and `payloadSchema`.
Use committed-inbox verification, an always-on production server, stable jobs-owned
delivery IDs and current connection/account authority. Consent and grants are read
again after lookup and the pending audit. Local sandbox/read-only modes deny
production delivery. Cancellation stops egress but cannot discard evidence after
possible egress. A shared withdrawal/erasure barrier remains an integration need.

`MeasureGrant` locally replaces `eventTypes` with 1..16 `definitionIds`; shared
contract alignment belongs to step0a. Plugins own credentials, vendor mappings,
guarded HTTP and reconciliation. Admit the generic `CONVERSION_EVENT_CAPABILITY`
(`conversion.event.v1`), preserving the shared event ID across destinations.
`conversion.adjustment.v1` is reserved in documentation only; no adjustment fields,
actions, definition registry or vendor fallback are implemented.

Tracked links preserve the supplied `campaignId` on creation and resolution,
independently of UTM labels. Destination origins/query keys require explicit
admission. Duplicate query keys, credentials, fragments and unsafe protocols deny.
Resolution validates the stored destination again without following redirects.

CAC selects the earliest verified event per workspace/canonical subject/definition,
ordered by `(occurredAt,eventId,sourceId)` with binary ID ordering. It then applies
the declared account/model/campaign mapping and `[start,end)` period filters.
Repeated outcomes across sources or subsequent periods cannot acquire that customer
again for the same definition. Definitions are independent. Unmapped first outcomes
are excluded, even if a later outcome is mapped. Earlier outcomes arriving late can
restate a report. Contacts supplies canonical subjects; merge semantics need host
agreement. No separate acquisition table is introduced.

Reports echo `definitionId`, validate spend dimensions and label both sources.
Zero acquisitions yield `cacMinorUnits: null`; fractional minor units are retained.
Watermark means maximum counted event time (window start when empty), not completeness.
Snapshots and model corrections remain immutable.

`AttributionTouch` / `AttributionTouchPort` are types only. Web-events will supply
scoped first-party touches, with `limit` in 1..100. Measure stores no touches and
performs no automatic attribution. Contacts/server/plugin integration, HTTP/studio/
CLI surfaces and adjustment execution are deferred.

Tests cover memory, SQLite and loopback capability transport through shared B1
suites. Amendment regressions are written, not run under the owner's override.
See `HANDOFF.md` for the single final lane typecheck and remaining integration needs.
