## Position

Build Open Marketing as a durable server-side marketing product with a desktop operator console—not a desktop-only app and not a chat-first automation shell. Jini should run the agent experience and tool boundary; it must not become the marketing system of record.

Use the Tovu two-repo split:

```text
Open-Marketing/                 # product; deployable without Electron or Jini
  apps/control-api/
  apps/worker/
  apps/studio-web/
  packages/domain/
  packages/data-spine/
  packages/audience/
  packages/templates/
  packages/delivery/
  packages/journeys/
  packages/connectors/
  packages/agent-tools/
  packages/policy/
  packages/sdk/

Open-Marketing-Runner/          # desktop operator host
  src/main/
  src/renderer/
  src/sidecar/
  src/host/electron.ts
```

The dependency arrow is `Runner → Open-Marketing SDK`, never reverse. The product needs to run workers while the operator’s laptop is closed: scheduled sends, delivery callbacks, journey waits, webhook ingestion, and suppression changes cannot honestly live inside a desktop process. Runner is still valuable: it is the local, opinionated workspace for an operator, local agent credentials, sidecar supervision, and connection profiles for one or more Open Marketing installations.

The product’s first real package is `@open-marketing/data-spine`. It owns Postgres tables `subject`, `subject_identifier`, `subject_merge`, `attribute_definition`, `event`, `suppression`, and `message_delivery`. Nothing is allowed to treat email address as a primary identity. Add `preference`, `preference_token`, and `consent_receipt` alongside suppression; a signed preference URL must ship with the first sending release.

`@open-marketing/audience` owns a typed condition-tree AST, `segment`, `segment_revision`, and a single compiler from that AST to SQL. Segments are evaluated live. Do not introduce a profile cache, CDP, Kafka, or ClickHouse. A campaign may create a release-specific recipient snapshot for approval and ledgering, but that is not a second segmentation engine.

`@open-marketing/templates` owns `template`, `template_version`, rendering, base layouts, unsubscribe/preference compliance blocks, and test rendering. Preview must call the exact same render function as production with a mocked subject and an explicit event payload. No “preview renderer.”

`@open-marketing/delivery` owns sending accounts, `campaign`, `campaign_release`, `campaign_recipient`, `message_delivery`, provider callbacks, bounce/complaint processing, and per-recipient suppression checking immediately before dispatch. Its central API is:

```text
sendability(subject, channel, purpose, sending_account, now)
  -> { allowed: boolean, reason: ... }
```

Both audience estimation and the dispatcher call it. A sendability mismatch is a correctness bug, not an edge case.

`@open-marketing/journeys` is the new product-specific engine package. It owns `journey`, immutable `journey_version`, `journey_node`, `journey_edge`, and `journey_run`. A journey run stores its pinned version, current node, `resume_at`, and `wait_event`; the worker polls Postgres and advances it transactionally. Use `FOR UPDATE SKIP LOCKED`, idempotency keys for effects, and an injectable `Clock` from commit one. Do not add Temporal, a workflow VM, or subprocess checkpointing for enter/delay/branch/send/exit.

Jini is consumed, not forked into a marketing framework:

- `@jini-ai/protocol`, `daemon`, and `agent-runtime` run and journal the operator agent.
- `@jini-ai/chat` supplies the chat surface inside Runner.
- `@jini-ai/desktop-host` defines the desktop-host boundary; Runner supplies its Electron implementation.
- `@jini-ai/agentic` publishes agent capabilities from the Studio surface where useful.
- `@jini-ai/http-kit`, `mcp`, `artifacts`, and `tokens` are useful integration plumbing, but none owns campaign state.

I would add one generic Jini package, `@jini-ai/approval-gates`: typed proposed effects, immutable approval payloads, expiry, signer identity, and execution receipts enforced at the daemon tool boundary. It must remain product-neutral. Open Marketing supplies the marketing policy and manifest format; Jini supplies the generic guarantee that a model cannot manufacture an approval token and then execute its own high-risk tool call.

## Product surface

Chat is a trap as the primary surface. Marketing is a spatial, quantitative, and forensic job. A sentence such as “send the re-engagement campaign to inactive users” hides audience definition, consent state, sender account, exclusions, content, rate limits, timing, and a potentially irreversible recipient set. A transcript is a poor place to inspect any of those.

The main Runner window should be a workbench:

- A left rail: Overview, Audiences, Campaigns, Journeys, Templates, Deliveries, People, Settings.
- A persistent top context bar showing workspace, sender account, environment, and production status.
- A central canvas appropriate to the object: a segment builder with estimate and exclusion reasons; a graph editor for a journey version; a template editor with realistic recipient preview; and a delivery ledger with recipient-level state and provider events.
- A right-side Agent drawer, collapsible but always available. It can explain data, draft objects, construct a segment condition tree, propose a journey revision, locate a failed delivery cohort, and create a release plan. Its output is a visible product artifact, not merely chat text.

The Campaign Release screen is the most important screen in the product. It displays the template version, from/reply-to identity, audience revision, recipient snapshot count, sendability exclusion counts, destination-domain distribution, schedule, frequency/rate limits, and the exact immutable release hash. The delivery ledger then shows the same release and reconciles all aggregate analytics against `message_delivery`; metrics never come from a separate analytics truth.

## Agent boundary

The agent may autonomously perform read-only analysis and reversible drafting:

- Query aggregate performance and inspect authorized subject records.
- Draft a template, segment condition tree, preference copy, or journey version.
- Render previews and test sends to an explicitly configured internal test list.
- Create a proposed campaign release, including predicted sendability exclusions and a recipient snapshot.
- Pause a currently failing provider integration if policy defines a hard safety threshold.

It may not autonomously create an external marketing effect. It cannot activate a journey, send a campaign, change a sender identity, import or merge identities, alter consent/suppression state, install credentials, add a webhook destination, or expand data access.

The human gate is not a conversational “yes.” Production release requires an authenticated, separate-principal approval against an immutable manifest: campaign/journey revision hash, template hash, audience query hash, recipient snapshot hash and count, suppression/exclusion reasons, sender account, schedule, rate caps, and expiry. Approval mints a single-use bounded capability. Changing content, audience logic, sending identity, caps, or schedule invalidates it.

For journeys, approval authorizes a specific immutable journey version with maximum entries, maximum messages per subject, allowed channels, and an expiry/renewal period. The worker still checks sendability at dispatch time. A model may prepare the release; it can never approve it, nor use a previously approved capability outside its exact bounds.

## The failure I predict

The plan will fail first through false confidence in chat-mediated sending: someone will optimize for the impressive demo where an agent “finds inactive users and emails them,” before identity, consent, suppression, and release manifests are treated as the product. The result will be an agent-generated audience that looks plausible in a transcript, reaches the wrong merged identities or legally unsendable contacts, and sends before anyone can inspect the actual population. That incident will define the product more than any clever agent runtime feature. The cure is architectural, not prompt engineering: identifiers first, one sendability function, immutable releases, and a UI designed to make a 120,000-person decision inspectable.
