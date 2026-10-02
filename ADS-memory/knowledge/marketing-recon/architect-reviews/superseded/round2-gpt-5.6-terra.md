Open Marketing should be one control plane, not one undifferentiated product. Lifecycle, paid media, and creative are three operational systems sharing identity, assets, approvals, and reporting. The Electron app is a strong authoring console, but a desktop-only operational surface is wrong: an ad-account suspension or runaway spend needs a server-hosted emergency stop page and CLI reachable when the operator’s laptop is unavailable.

## Modules

| Module | Owns | Status |
|---|---|---|
| Workspace and RBAC | Organizations, workspaces, roles, service accounts, campaign-scoped permissions | NEW |
| Product data spine | Postgres `subject`, identifiers, merges, attributes, events, consent, suppression, deliveries | NEW |
| Privacy and retention | DSARs, erasure, retention schedules, legal holds, consent evidence | NEW |
| Audit and business outbox | Immutable actor/action audit records and reliable business-event publishing | NEW |
| Agent execution | Agent runs, durable run events, tool boundary, scheduler | JINI — `@jini-ai/daemon`, `protocol`, `agent-runtime`, `agentic` |
| Agent context | Campaign notes and retrieval context; never campaign truth or approval state | JINI — `@jini-ai/memory` |
| Agent console | Three-pane desktop UI: navigation, object canvas, collapsible agent pane | JINI — `@jini-ai/chat`, `@jini-ai/ui`, `@jini-ai/core` |
| Desktop host | Electron lifecycle, local server sidecar, deep links, single-instance locking | JINI — `@jini-ai/desktop-host` |
| Emergency operations UI | Browser-accessible pause/kill controls, incident status, approval recovery | NEW |
| Approval service | Durable, answerable policy decisions with expiry, evidence, and actor identity | JINI — `@jini-ai/approvals` |
| Tool-policy gateway | Maps agent intent to product commands; enforces scopes, risk tiers, schemas, and audit | NEW |
| Credential vault | Per-workspace OAuth/API credentials, rotation, encrypted storage, scope records | NEW, using `@jini-ai/capability-providers` auth port |
| Blob storage | Original files, rendered creative, exports, immutable content hashes | EXTERNAL — S3-compatible object storage; accessed through JINI blob port |
| MCP broker and registry | Server manifests, tool schemas, versions, trust class, capability grants, health | NEW, using `@jini-ai/mcp` and `registry` |
| Lifecycle audience engine | Segment definitions, estimates, exclusions, materialized audience snapshots | NEW |
| Sendability policy | The single `sendability(subject, channel, purpose, …)` decision used by estimation and dispatch | NEW |
| Messaging rendering | Templates, variables, localization, preheader, preview through the real `render()` path | NEW |
| Delivery execution | Idempotent provider submission, webhook correlation, delivery ledger, retries | NEW |
| Provider connectors | Email and SMS provider APIs, inbound webhooks, bounce and complaint mapping | EXTERNAL — SES, Postmark, Twilio, etc. |
| Journeys | Versioned journey definitions and `journey_run` execution via `resume_at`, `wait_event`, and `SKIP LOCKED` pollers | NEW |
| Deliverability operations | Domain setup, suppression review, sender reputation, rate limits, seed tests | NEW |
| Campaign planning | Cross-channel campaign object, calendar, objectives, drafts, launch checklist | NEW |
| Ad-account connections | Platform account discovery, OAuth grants, account health, policy/review state | NEW |
| Media model | `media_campaign`, `ad_group`, `ad_set`, ads, platform mappings, review records | NEW |
| Budget and pacing | Budget envelopes, daily/lifetime caps, bid bounds, pacing targets, spend forecasts | NEW |
| Paid-media execution | Idempotent platform mutations, status synchronization, drift detection, pause actions | NEW |
| Platform connectors | Meta, Google Ads, TikTok, LinkedIn APIs and reporting APIs | EXTERNAL |
| Advertising audiences | Consent-qualified custom-audience exports, hashes, deletion propagation, lookalike requests | NEW |
| Creative rotation | Creative bindings, frequency/age rules, experiment cells, platform eligibility | NEW |
| DAM | `asset`, `asset_version`, `asset_rendition`, folders, tags, search, asset relationships | NEW |
| Rights and provenance | Prompt/model/seed/source inputs, licenses, expiration, creator, territory, usage restrictions | NEW |
| Brand governance | Brand kits, templates, claims, restricted terms, mandatory disclosures, review rules | NEW |
| Creative generation | `creative_job`, provider request/result handling, retries, quotas, render pipelines | NEW |
| Generation providers | Image/video generation through Higgsfield, Seedance, and other MCP/API providers | EXTERNAL |
| Jini artifacts bridge | Run attachments and generation receipts; not the asset library or rights system | JINI — `@jini-ai/artifacts` |
| Event ingestion | Webhooks, browser/server conversion events, imports, deduplication, source lineage | NEW |
| Analytics observations | Raw immutable provider metric observations, restatements, timestamps, source versions | NEW |
| Metrics and reporting | Metric catalog, rollups, dashboards, exports, scheduled reports | NEW |
| Attribution and experiments | Touchpoints, attribution-model versions, holdouts, incrementality results, caveats | NEW |
| Monitoring and incident response | Connector lag, failed jobs, budget breaches, delivery anomalies, paging | NEW |
| Notifications | Approval requests, spend alarms, review rejections, journey failures | EXTERNAL — email/SMS/push provider |

`@jini-ai/artifacts` is useful for a run’s prompt, provider receipt, and generated-output attachment. It is not a DAM: it does not provide rendition families, rights expiry, platform eligibility, asset approval, or long-lived creative search.

## Tool surface and risk

The agent receives product commands, never raw Meta, Google, SMTP, OAuth-token, or arbitrary MCP tools.

| Tool group | Examples | Tier |
|---|---|---|
| Read and investigate | `campaign.get`, `segment.estimate`, `metrics.query`, `asset.search`, `ad_account.health` | Autonomous |
| Draft objects | `campaign.create_draft`, `journey.create_version`, `media_plan.draft`, `asset.tag`, `report.create` | Autonomous |
| Low-impact choices | `creative.generate_preview`, `asset.make_renditions`, `import.map_columns`, `segment.save` | Confirm-in-run when outside a preapproved creative-credit or import policy |
| Lifecycle launch | `journey.activate`, `broadcast.launch`, `sender.change` | Durable approval |
| Paid-media commitment | `media_order.activate`, `budget.raise`, `bid_strategy.change`, `audience.export`, `platform.connect` | Durable approval |
| Bounded optimization | `pace.adjust`, `creative.rotate`, `bid.adjust_within_envelope`, `pause_underperformer` | Autonomous within an active approved envelope |
| Emergency actions | `campaign.pause`, `ad_account.kill_switch`, `delivery.halt`, `connector.disable` | Autonomous, immediate, fully audited |
| MCP administration | `mcp.register`, `mcp.grant_capability`, `mcp.rotate_credential` | Durable approval |

A weekly paid-media approval batches campaign creation, ad-set creation, creative bindings, and ordinary bid/pacing changes. It must not ask thirty times while creating thirty ads. One exception is expansion beyond its envelope: new geography, new ad account, new audience-export purpose, higher budget, a different conversion objective, or a new external credential creates a new durable approval.

## Money boundary

Messaging has a per-recipient permission decision; paid media has a continuous financial control loop. The relevant object is a durable `media_order_approval`, not an approval for each API call. It contains:

- platform account and connected credential identity;
- campaign/ad-set topology and approved creative families;
- start/end dates, including the three-week window;
- campaign lifetime cap, daily cap, hourly pacing ceiling, and account-level reserve;
- bid strategy, bid/ROAS/CPA bounds, optimization event, target geographies, and placements;
- audience snapshot or audience rule, including advertising-export consent evidence;
- maximum autonomous adjustment range, such as ±10% bid and rotation among preapproved creative;
- projected spend, source forecast version, approver, expiry, and revocation conditions.

Platform credentials live only in the always-on server vault. The desktop client and agent see a capability such as `media_order.activate(order_id)`, never an OAuth token. Before activation, the server writes platform-side campaign and ad-set caps, re-reads them, then enables delivery. A pacing worker compares observed spend against the approved curve every few minutes, limits further mutations when reporting is delayed, and pauses on a hard-cap breach. The kill switch writes a local deny record first, then issues platform pause requests and pages an operator; it remains effective even if a platform API is degraded.

Custom-audience upload needs a distinct consent purpose such as `advertising_audience_export`. The export ledger records the audience snapshot, hashing method, platform audience identifier, and deletion job. Consent withdrawal produces a platform deletion request; it does not wait for the next campaign sync.

## Creative jobs and MCP trust

Creative generation is a separate asynchronous subsystem, not a journey and not a long-lived Jini run. A `creative_job` has `provider_connection_id`, normalized prompt, input asset versions, requested renditions, cost ceiling, idempotency key, `external_job_id`, callback secret, status, and retry policy. Workers claim jobs with `FOR UPDATE SKIP LOCKED`; callbacks advance them. A Jini run can create or inspect a job, but the job table is the durable business state because external video generation can take hours.

Each immutable original is addressed by an `asset_version` ULID and a SHA-256 blob digest. Derived 1:1, 4:5, 9:16, 16:9, and platform-specific renditions are separate `asset_rendition` rows linked to that version. `asset_provenance` records model, prompt revision, seed, source assets, provider receipt, and generation policy. `rights_grant` records license, owner, regions, media channels, expiry, and restrictions. An expired or unapproved asset cannot be attached by the paid-media executor.

Third-party MCP servers sit behind an MCP broker. The registry stores a pinned manifest snapshot, declared tools, publisher, trust class, allowed egress hostnames, workspace grant, credential scope, and audit history. Every call goes through a typed proxy that validates arguments and output shape. An external MCP receives only a narrowly scoped provider token or signed request token; it never receives email-provider, ad-platform, database, or approval credentials.

Tool output is tainted external data: stored raw for audit, displayed with provenance, and never treated as authority to invoke another tool. The broker does not permit tool chaining from tool output, arbitrary URL fetching, filesystem access, or credential discovery. A compromised Higgsfield MCP can at worst generate or expose material inside its explicitly granted creative scope; it cannot invoke `broadcast.launch` or `media_order.activate`.

## Analytics truth model

Use one operational source of truth with two explicitly different fact classes in Postgres:

1. Local receipt truth: `message_delivery`, consent decisions, audience exports, commands issued, approved caps, and local click/conversion events.
2. External reported truth: immutable `media_metric_observation` and `platform_conversion_observation` rows with provider, report window, retrieval time, metric definition, sampling flag, and restatement version.

They will disagree, and the UI must say why. “Delivered” reconciles against the delivery ledger. “Meta purchases” reconciles against Meta’s latest observation, not the ledger. Attribution is a versioned calculation over touchpoints and observations; it is not a rewritten delivery record. On erasure, personal touchpoint linkage is removed or tombstoned while already-produced aggregate facts retain no subject identifier and remain reproducible from their recorded inputs.

Postgres holds initially: partitioned event/observation tables, precomputed daily rollups, and indexed campaign/date queries are adequate. Add ClickHouse only when measured ingestion volume or dashboard scan latency proves it necessary. If added, it is a derived analytical projection fed from immutable Postgres observations, not a second system allowed to redefine delivery or spend truth.

## Build order

1. Foundation: Postgres data spine, `Clock` port, workspace/RBAC, audit outbox, approval rows, tool-policy gateway.
2. Lifecycle: consent, sendability, audience estimates, rendering, provider delivery ledger, then journeys.
3. Campaign and DAM: campaign canvas, assets, rights, renditions, brand policy, creative-job workers.
4. Paid media: account connections, media model, budget envelopes, approval-gated activation, pacing, kill switch.
5. Analytics: ingestion, metric definitions, reconciled reports, attribution, exports.
6. Hardened MCP and operations: registry, sandboxed broker, credential rotation, alerts, browser emergency console.

The first-commit tell should be `apps/server/db/migrations/0001_control_plane.sql`: it contains the settled identity/consent tables plus `approval`, `audit_event`, `budget_envelope`, and an injectable `Clock` contract beside it. If that commit instead starts with chat components or a platform connector, the product has already drifted toward a demo.

The biggest failure will be treating the agent as the product’s policy engine. A persuasive agent can produce convincing campaign prose while quietly crossing a consent purpose, rights expiration, bid ceiling, or platform-review constraint. If permission, budget, asset eligibility, and MCP capability checks are encoded in prompts or agent memory rather than Postgres-backed server policy, the first urgent “fix performance now” request will turn the system into an untraceable spend and compliance machine.
