# campaigns

Public entry: `@open-marketing/campaigns` only.

Vendor-neutral campaign drafts, verified PAUSED creation, one-call exact launch
proposals, durable intent and read-only reconciliation. Factories start no services.
All methods return typed outcomes; denials return errors and uncertainty is explicit in receipts.

Server composition supplies repository, capabilities, assets, safety, the single
jobs outbox, clock, IDs and audit. Optional observers receive correlation/trace/run
IDs. Production never uses the memory safety/provider/job doubles as authority.

Typical flow (check each outcome before using its value):

```ts
import { createCampaignService } from "@open-marketing/campaigns";

const campaigns = createCampaignService(serverPorts, { observer });
const created = await campaigns.createPaused({ context, draft });
// After verified PAUSED creation:
const card = await campaigns.proposeLaunch({ context, campaignId, flight });
// Safety renders and approves card.value.operations[0] for exactly one call.
const queued = await campaigns.launch({ context, request: approvedLaunchRequest });
// A server worker dispatches the persisted operation under current authority:
const dispatched = await campaigns.dispatch({ context, operationId });
// For an unknown result, read evidence; never send the mutation again:
const observed = await campaigns.reconcile({ context, operationId });
```

Drafts admit neither activation nor budget fields. A proposal freezes account,
creative revisions, flight and expected exposure; its one `ad_spend` envelope
must match every frozen field. Later spend needs a new operation and approval.
There is no budget envelope, reallocation or generic budget-mutation API.

Creation acknowledgement alone is insufficient: the full nonempty, unique
hierarchy must read back PAUSED and identify the creation operation. Partial or
ambiguous evidence remains unknown. A launch requires that matching creation
job to be submitted. Dispatch compares the CAS claim with the immutable queued
intent, rechecks campaign and creative evidence, then enters safety's final
dispatch barrier. Safety and backend must recheck current authority at egress.

After claim, the operation cannot be reclaimed or blindly retried. Provider
throws, lost acknowledgements and persistence failures require reconciliation.
`submitted` means a provider acknowledgement or matching verified evidence;
it does not claim a fresh observed ACTIVE state. Use reconcile for that evidence.
The draft receipt retains desired PAUSED state; actual state is stored separately
in `CampaignRecord.observation`.

`createSqlCampaignRepo` uses the injected server-owned SQL query port. It validates
stored JSON and row identities, appends observations, and uses portable parameterized
SQL. Its additive migration is feature-owned and must be applied only by an
authorized server operation. No driver, connection, schema or second outbox is
constructed here. A saved draft can outlive a failed enqueue; the immutable intent
and job must commit together inside `CampaignJobPort.enqueue`.

`createCampaignCapabilityAdapter` validates bounded requests/results and forwards
stable operation IDs, permits, timeout and cancellation. `CampaignBackendPort`
owns timeout enforcement, provider idempotency/reconciliation, account binding,
transport and final permit verification. Adapt server federation using published
`@jini-ai/mcp` public exports; keep vendor translation/configuration in Agent Plugins.
No MCP, OAuth, credentials, DB driver or temporary Jini shim is implemented here.

Memory doubles exist for repository, provider, assets, safety, jobs, audit and
observer. B1 suites exercise memory/SQL repositories and memory/capability adapters;
SQL uses a test-only in-memory SQLite binding and capability tests use an in-memory
backend. Acceptance tests cover exact approval, hierarchy, recovery, halt, modes,
isolation and faults across claim/effect/persistence boundaries.

Verification for the 2026-10-12 continuation follows the owner's override: tests
written, not run; no build/om:check/install. Only one campaigns typecheck is allowed.
Server bindings to safety/jobs/media/federation, HTTP/studio/CLI integration and
live-provider verification belong to their owning jobs and are deferred here.
