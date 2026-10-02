### 1. The Complete Module List

#### Lifecycle & Identity
- **`identity-spine`** (`NEW`): Owns tables `subject`, `subject_identifier`, `subject_merge`, `attribute_definition`, `consent`, and `suppression`. *Marketing job: Maintains an authoritative, deduplicated profile of every lead and customer across anonymous ad clicks and identified email/SMS subscriptions.*
- **`sendability-guard`** (`NEW`): Owns the pure `sendability(subject, channel, purpose)` policy function and dry-run estimation logic. *Marketing job: Enforces regulatory opt-in, fatigue frequency rules, and suppression compliance prior to broadcast.*
- **`journey-engine`** (`NEW`): Owns the `journey_run` table, `journey_version` pinning, and `FOR UPDATE SKIP LOCKED` poller over `resume_at` and `wait_event`. *Marketing job: Orchestrates automated multi-stage behavioral nurture sequences.*
- **`message-dispatcher`** (`NEW`): Owns delivery queue processing, external ESP/SMS provider adapters (Amazon SES, Twilio), and the immutable `message_delivery` ledger. *Marketing job: Transmits rendered emails and SMS messages to end-user inboxes and devices.*
- **`template-renderer`** (`NEW`): Owns the unified preview and execution-time token substitution engine, built directly against `@jini-ai/cms`. *Marketing job: Merges dynamic customer profile attributes into personalized copy and responsive layouts.*

#### Paid Media & Budget Control
- **`ad-account-manager`** (`NEW`): Owns API credentials, account status heartbeats, and rate-limit backoff across Meta Marketing API, Google Ads API, TikTok Ads API, and LinkedIn Ads API. *Marketing job: Maintains programmatic connectivity to ad networks and flags account suspension notices.*
- **`campaign-budget-governor`** (`NEW`): Owns tables `campaign_budget_cap`, `spend_ledger`, hourly burn pacing, and the emergency hard kill-switch. *Marketing job: Enforces contractual spending limits to prevent autonomous algorithmic overspend and bid runaways.*
- **`ad-set-orchestrator`** (`NEW`): Owns platform-level campaign hierarchies, ad-set configurations, bidding strategy flags, and flight schedules. *Marketing job: Translates audience targeting and bidding parameters into live ad network configurations.*
- **`audience-sync`** (`NEW`): Owns the batch SHA-256 hashing and synchronization pipeline for Meta Custom Audiences and Google Customer Match, reconciled strictly with `consent`. *Marketing job: Pushes customer segments to ad networks to drive retargeting and lookalike audience modeling.*
- **`creative-rotator`** (`NEW`): Owns ad creative assignment, performance monitoring (frequency, CTR drop-off), and automated variant rotation. *Marketing job: Replaces decaying ad creatives with fresh variants before performance drops off.*

#### Conversion Tracking Loop & Lead Ingestion
- **`conversion-tracking-bridge`** (`NEW`): Owns server-side dispatch to Meta Conversions API (CAPI) and Google Enhanced Conversions from the `event` stream, filtering through `consent` and `suppression`. *Marketing job: Feeds server-side conversion signals back into ad platform bidding algorithms.*
- **`lead-capture-gateway`** (`NEW`): Owns public form endpoints, webhook handlers, and the binding of `gclid`, `fbclid`, and UTM parameters to `subject_identifier`. *Marketing job: Captures inbound prospects on landing pages and converts anonymous ad clicks into identified customer records.*

#### Creative Production & Asset Management
- **`mcp-generation-client`** (`NEW`): Owns JSON-RPC protocol adapters to external creative generation servers (`external-mcp-higgsfield`, `external-mcp-seedance`), handling asynchronous job dispatch and parameter validation. *Marketing job: Requests high-fidelity marketing visuals and video variations from external AI engines.*
- **`asset-provenance-registry`** (`NEW`): Owns table `creative_asset` storing prompt lineage, model fingerprints, seed parameters, licensing flags, and per-platform aspect ratio variants. *Marketing job: Catalogues creative assets with full intellectual property provenance and platform-specific format compliance.*
- **`blob-storage-manager`** (`JINI` - `@jini-ai/capability-providers`): Owns blob storage abstraction (`DbProvider` and blob drivers) for raw media uploads and S3/GCS signed URL generation. *Marketing job: Delivers scalable file hosting for large marketing media files.*
- **`artifact-workbench`** (`JINI` - `@jini-ai/artifacts`): Owns draft creative asset bundles, transient preview cards, and intermediate generation variants rendered in the operator canvas. *Marketing job: Presents draft image and video options to marketing operators prior to catalog commit.*

#### Analytics & Attribution
- **`attribution-engine`** (`NEW`): Owns deterministic touchpoint joins linking `event` to `message_delivery` and click identifiers (`fbclid`, `gclid`), calculating first-touch, last-touch, and linear models. *Marketing job: Measures true cross-channel revenue attribution without relying on self-serving ad network reporting.*
- **`ad-metrics-collector`** (`NEW`): Owns asynchronous polling of delayed, restated impression, spend, and conversion reports from Meta Insights and Google Ads reporting APIs into table `ad_performance_snapshot`. *Marketing job: Ingests platform-reported spend and conversion metrics for fiscal auditing and pacing.*
- **`reporting-cube`** (`NEW`): Owns materialized rollup views over first-party events and ad metrics for high-speed aggregate dashboard queries. *Marketing job: Computes high-level marketing performance indicators, blended ROAS, and CAC.*

#### Agent Runtime, UI, & Governance
- **`agent-daemon`** (`JINI` - `@jini-ai/daemon`): Owns agent run lifecycles, execution boundaries, background routine scheduling, and durable run event logging. *Marketing job: Provides the autonomous agent execution environment driving marketing workflows.*
- **`agent-runtime`** (`JINI` - `@jini-ai/agent-runtime`): Owns adapter registries and execution boundaries for underlying CLI-based agent runtimes. *Marketing job: Interfaces the application with underlying AI model CLIs.*
- **`chat-canvas-surface`** (`JINI` - `@jini-ai/chat` + `@jini-ai/ui`): Owns the three-pane desktop interface (`LeftNav`, center `CanvasView`, collapsible right `AgentPane`). *Marketing job: Gives marketers an interactive visual canvas for inspecting and editing agent-generated marketing objects.*
- **`approval-broker`** (`JINI` - `@jini-ai/approvals`): Owns durable approval requests, timeout lifecycles, and cryptographic signature capture for high-consequence operations. *Marketing job: Prevents accidental bulk sends or unapproved ad spending via explicit operator sign-off.*
- **`mcp-sandbox-proxy`** (`NEW`): Owns network-isolated process supervision, credential stripping, and tool result sanitization for third-party MCP servers. *Marketing job: Isolates unvetted third-party creative AI generators from accessing core customer records or payment credentials.*
- **`desktop-shell`** (`JINI` - `@jini-ai/desktop-host`): Owns the Electron main process lifecycle, single-instance locks, deep link schemes, and supervision of the background `apps/server` daemon. *Marketing job: Packages the entire marketing suite into an installable desktop operating console.*

#### External Services & MCP Tools
- **`external-mcp-higgsfield`** (`EXTERNAL`): Image and motion generation API reached via MCP protocol.
- **`external-mcp-seedance`** (`EXTERNAL`): Video synthesis and character motion API reached via MCP protocol.
- **`external-ad-meta`** (`EXTERNAL`): Meta Graph & Marketing API, plus Meta Conversions API (CAPI).
- **`external-ad-google`** (`EXTERNAL`): Google Ads REST/gRPC API, plus Google Enhanced Conversions.

---

### 2. The Tool Surface

#### Identity & Messaging
- `query_segment_size(definition_json)` -> **Autonomous**. Non-mutating read against `subject` and `attribute_definition` tables.
- `preview_template(template_id, mock_subject_id)` -> **Autonomous**. Renders copy through `template-renderer` into `CanvasView`.
- `stage_journey_draft(journey_manifest)` -> **Confirm-in-run**. Persists draft rows to `journey_version` with status `draft`.
- `publish_journey_version(journey_id, version_num)` -> **Durable-approval**. Activates the journey for live execution in `journey-engine`.
- `dispatch_blast_campaign(campaign_manifest)` -> **Durable-approval**. Batches template rendering, target segment, schedule, and audience resolution into a single approval manifest. Approving this single manifest authorizes sending to the resolved audience without individual message gates.

#### Creative Production
- `search_asset_library(query_filters)` -> **Autonomous**. Searches `creative_asset` metadata.
- `inspect_asset_provenance(asset_id)` -> **Autonomous**. Reads prompt lineage and license records.
- `request_asset_generation(prompt, model, aspect_ratios, seed)` -> **Confirm-in-run**. Spawns rows in `creative_job` and expends metered inference compute within an approved per-run credit budget.
- `derive_aspect_ratio_variants(asset_id, ratios)` -> **Confirm-in-run**. Dispatches automated cropping and padding tasks via `mcp-generation-client`.
- `archive_creative_asset(asset_id)` -> **Autonomous**. Soft-deletes unreferenced assets in `creative_asset`.

#### Paid Media & Budgeting
- `get_campaign_insights(platform, campaign_id, date_range)` -> **Autonomous**. Reads `ad_performance_snapshot`.
- `inspect_creative_fatigue(ad_set_id)` -> **Autonomous**. Evaluates CTR decay and frequency metrics in `reporting-cube`.
- `rotate_ad_creative(ad_id, replacement_asset_id)` -> **Autonomous**. Swaps an existing ad creative variant inside an active ad-set when the frequency threshold exceeds policy and the replacement asset is pre-approved in `asset-provenance-registry`.
- `adjust_ad_set_pacing(ad_set_id, delta_percentage)` -> **Autonomous**. Rebalances spend across active ad-sets within a strictly bounded ±15% window of the approved daily envelope.
- `create_campaign_draft(campaign_spec)` -> **Confirm-in-run**. Stages campaign structures in table `ad_set_orchestrator` in `draft` status.
- `launch_campaign_flight(approval_manifest_id)` -> **Durable-approval**. Commits new campaigns or major bid strategy changes to Meta or Google.
- `sync_audience_to_platform(segment_id, platform)` -> **Durable-approval**. Authorizes uploading hashed customer identifiers to external ad networks.

#### Conversion Tracking & Attribution
- `inspect_attribution_funnel(date_range, model_type)` -> **Autonomous**. Reads calculated touchpoints from `attribution-engine`.
- `replay_failed_conversions(platform, time_window)` -> **Confirm-in-run**. Retries dead-lettered payloads in `conversion-tracking-bridge`.

#### Batching Strategy to Prevent Gate Fatigue
Gating individual API calls (such as creating individual ad groups, swapping single creatives, or adding email steps) leads directly to gate fatigue and blind rubber-stamping. We batch operations into a single immutable **Campaign Flight Manifest** in `@jini-ai/approvals`. A single approval authorizes the targeting criteria, the complete asset bundle across all required aspect ratios, the daily spend limits, the maximum lifetime spend cap, and the audience sync payload. Once that manifest receives operator sign-off, the agent runs completely autonomously within those strict boundaries: adjusting bid targets within a preset ceiling, rotating pre-approved creative assets as fatigue sets in, and tweaking ad-set delivery weights. The approval broker is invoked only when launching new campaigns, increasing hard spend caps, or modifying external audience sync definitions.

---

### 3. Money and the Irreversible Boundary

Ad spend cannot be recalled once an auction is won. Therefore, the boundary protecting capital differs fundamentally from the sending boundary: sending errors burn reputation and deliverability, but bidding errors burn cash uncontrollably.

```
[Agent Pane] ---> invokes tool: launch_campaign_flight(manifest)
                       |
                       v
[apps/server: campaign-budget-governor]
  |--> Asserts hard ceiling <= organization_max_cap
  |--> Writes durable row to @jini-ai/approvals: approval_manifest
                       |
                       v (Blocks execution; surface in CanvasView)
[Operator signs approval_manifest in ApprovalModal]
                       |
                       v (Signature written to Postgres)
[campaign-budget-governor unlocks API execution]
  |--> ad-account-manager holds tokens; injects into Meta/Google calls
  |--> Inserts row into campaign_budget_cap (flight duration, limits)
  |--> Enforces 24/7 background spend polling (halts if burn > 120% pace)
```

#### Credential Isolation
API credentials (`META_ACCESS_TOKEN`, `GOOGLE_ADS_REFRESH_TOKEN`) reside exclusively in encrypted storage within `apps/server`. Neither the Jini agent runtime, nor the external MCP servers, nor the frontend canvas ever receive raw API tokens. Tools accept only opaque internal IDs (e.g., `account_ref_id: "act_102938"`). The `ad-account-manager` hydrates these requests with credentials at the network egress boundary.

#### Budget Caps and Pacing Envelopes
Hard caps are enforced by `campaign-budget-governor` using table `campaign_budget_cap`:
```sql
CREATE TABLE campaign_budget_cap (
    campaign_id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    hard_limit_cents BIGINT NOT NULL,
    daily_envelope_cents BIGINT NOT NULL,
    lifetime_spend_cents BIGINT DEFAULT 0,
    hourly_max_burn_cents BIGINT NOT NULL,
    flight_start_at TIMESTAMPTZ NOT NULL,
    flight_end_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'throttled', 'halted'))
);
```

#### The Automated Kill-Switch
A native background worker in `apps/server` queries live spend every 15 minutes through `ad-metrics-collector`. If current spend exceeds `hourly_max_burn_cents`, or if cumulative spend crosses 98% of `hard_limit_cents`, the governor immediately invokes the platform pause endpoints directly, flipping all ad-sets to `PAUSED` without agent mediation. A manual hard kill-switch button in the `CampaignControlSheet` UI triggers `POST /api/v1/emergency-halt`, which executes platform-level campaign pause requests within sub-second timeouts.

#### Permitted Autonomous Scope
Inside an approved flight, the agent may autonomously adjust ad-set budgets by at most ±15% per 24-hour cycle, redistribute funds across existing ad-sets, and pause creatives exhibiting a CTR drop greater than 30% against the ad-set baseline. It cannot alter the total campaign spend cap, extend the end date, or switch the optimization goal (e.g., from *Value* to *Impressions*).

#### Approval Object Structure for a Multi-Week Campaign
When launching a 3-week flight, `@jini-ai/approvals` generates an `approval_manifest` payload containing:
1. `campaign_id` and targeting parameters (geos, demographics, excluded audiences).
2. Pinned `flight_start_at` and `flight_end_at`.
3. Financial constraints: `hard_limit_cents: 1500000` ($15,000.00), `daily_envelope_cents: 75000` ($750.00), and `max_cpc_bid_ceiling_cents: 450` ($4.50).
4. An immutable array of asset hashes from `creative_asset` representing all permitted visual variants.
5. The associated `consent_hash` certifying that targeted audience sync lists complied with user consent declarations.

---

### 4. Creative and MCP Integration

#### Generation Job Modeling
AI image and video generation through Higgsfield and Seedance takes anywhere from 30 seconds to several minutes, exhibits high failure rates, and requires exponential backoff polling. This lifecycle must not run inside the Jini agent execution loop (which blocks conversational flow) nor inside the `journey-engine` poller (which processes sub-second customer lifecycle transitions).

We introduce a dedicated asynchronous table in Postgres, driven by a dedicated poller in `apps/server`:
```sql
CREATE TABLE creative_job (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_mcp TEXT NOT NULL,
    external_job_id TEXT,
    prompt TEXT NOT NULL,
    parameters JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'dispatched', 'polling', 'completed', 'failed')),
    poll_after TIMESTAMPTZ NOT NULL,
    attempts INT DEFAULT 0,
    result_asset_id UUID REFERENCES creative_asset(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
```
The poller claims pending jobs using `SELECT id FROM creative_job WHERE status IN ('queued', 'polling') AND poll_after <= clock_timestamp() LIMIT 10 FOR UPDATE SKIP LOCKED`. When completed, it saves the asset record and emits an event to `@jini-ai/daemon` to notify the waiting agent.

#### Asset Storage, Versioning, and Addressing
`@jini-ai/artifacts` is designed as an ephemeral working draft scratchpad for agents, not a durable Digital Asset Management (DAM) repository. We build `asset-provenance-registry` on top of Postgres and `@jini-ai/capability-providers` blob storage. Assets are addressed across the platform by immutable content-addressed URIs: `urn:asset:sha256:<content_hash>`. 

Table `creative_asset` records:
- `id`: Unique asset UUID.
- `content_hash`: Cryptographic SHA-256 digest of the binary payload.
- `blob_uri`: S3/GCS or local filesystem URI.
- `aspect_ratio`: One of `1:1`, `9:16`, `16:9`, `4:5`, `2:3`, `1.91:1`.
- `provenance`: JSONB capturing `{ provider, model_version, prompt, negative_prompt, seed, parent_asset_id }`.
- `rights_and_licensing`: Flags verifying commercial generation clearance and trademark review status.

#### Third-Party MCP Trust Boundary
External MCP servers run code we do not control. To prevent prompt-injection attacks and lateral network movement, external MCP connections are isolated behind `mcp-sandbox-proxy`:
1. **Process Isolation**: MCP servers run inside isolated sub-processes with zero access to internal host loopback services, the Postgres network port, or local file trees.
2. **Credential Scoping**: External MCP servers receive only an isolated vendor API key (e.g., `HIGGSFIELD_API_KEY`). They are never granted database credentials, session tokens, or ad-network API secrets.
3. **Storage Air-Gapping**: The MCP server cannot write directly to our asset repository. It emits a remote download URL, which `mcp-sandbox-proxy` fetches, scans for malicious payloads/MIME violations, hashes, and streams into our internal blob store.
4. **Prompt Injection Defense**: Text output and tool results from external MCP servers pass through a strict JSON schema validator before entering the agent context. This strips hidden control instructions, prompt injection payloads, and malformed markdown before the agent can interpret the response.

---

### 5. Analytics Truth Model

#### One Truth or Two?
There are fundamentally **two distinct truths**, and conflating them will corrupt reporting integrity:
1. **The Internal Operational Ledger**: Composed of immutable, deterministic rows in `message_delivery`, `event`, and `lead-capture-gateway`. This records exact delivery timestamps, raw transactional purchases, and first-party form submissions joined by `subject_identifier`. It balances down to the single penny and exact millisecond.
2. **The Ad Platform Performance Estimates**: Composed of delayed, sampled, and model-attributed metrics harvested by `ad-metrics-collector` into `ad_performance_snapshot`. Meta and Google use proprietary multi-day lookback windows (e.g., 7-day click, 1-day view-through). Both will simultaneously claim 100% credit for the exact same conversion event.

We store both, but we **never force them into a synthetic reconciliation**. 

```
[Ad Networks: Meta/Google]                 [Anonymous User Ad Click]
         |                                             |
 (Reports spend, clicks,                         (Carries gclid / fbclid)
  platform-attributed conversions)                     v
         |                                 [lead-capture-gateway]
         v                                             |
[ad_performance_snapshot]                  (Records click ID to subject_identifier)
(Delayed, sampled, directional)                        v
                                           [event] (e.g. order_completed)
                                                       |
                                                       v
                                           [attribution-engine]
                                           (Deterministic first-party truth)
                                                       |
                                           [conversion-tracking-bridge]
                                           (Flushes hashed conversion back to CAPI)
```

The system separates these concerns cleanly in the `AnalyticsView` UI:
- The **Executive Finance Dashboard** displays first-party ledger truth from `event` and `attribution-engine` (actual bank revenue, deterministic UTM/click-id tracking, true CAC).
- The **Campaign Optimization Console** displays platform-reported performance from `ad_performance_snapshot` (ROAS estimates, algorithmic bidding status, impression shares) used strictly to guide bidding decisions.

#### Postgres vs. ClickHouse
**Postgres holds; ClickHouse is not needed.** Introducing ClickHouse adds substantial operational complexity, requiring binary zoo distributions for local desktop sidecars, dual-database schema migrations, and eventual consistency sync lag.

Postgres easily handles tens of millions of events when designed properly:
- Partition table `event` by month (`PARTITION BY RANGE (timestamp)`).
- Place BRIN (Block Range Index) indexes on `timestamp` and B-tree indexes on `(subject_id, timestamp)` and `((metadata->>'gclid'))`.
- Use native Postgres materialized views with automated rollups in `reporting-cube` to serve real-time aggregation queries in sub-50 milliseconds.
ClickHouse should only be evaluated if event ingest exceeds 500 writes per second sustained—a scale far beyond a typical desktop-sidecar architecture.

---

### 6. Build Order and First-Commit Tell

```
Phase 1: Identity & Lead Ingestion Spine
  |--> Database migration: subject, subject_identifier, event, consent, suppression
  |--> Implement sendability() pure function + unit test
  |
Phase 2: Messaging Delivery & Approvals
  |--> journey-engine poller (FOR UPDATE SKIP LOCKED) + injectable Clock port
  |--> message-dispatcher + @jini-ai/approvals integration
  |
Phase 3: Conversion Tracking Bridge & Form Gateway
  |--> lead-capture-gateway (captures gclid/fbclid to subject_identifier)
  |--> conversion-tracking-bridge (CAPI / Enhanced Conversions with consent checks)
  |
Phase 4: Paid Media Guardrails & Platform Connectors
  |--> ad-account-manager + campaign-budget-governor (hard caps + kill-switch)
  |--> Meta/Google Ads API flighting integration
  |
Phase 5: Creative Production Pipeline & MCP Sandboxing
  |--> creative_job poller table + mcp-sandbox-proxy
  |--> External Higgsfield/Seedance MCP adapters + asset-provenance-registry
  |
Phase 6: Unified Desktop App & Canvas Integration
  |--> apps/desktop Electron shell wrapping apps/server via @jini-ai/desktop-host
  |--> Three-pane workspace UI (LeftNav, CanvasView, AgentPane)
```

#### Phased Implementation Plan
- **Phase 1: Identity & Lead Ingestion Spine**. Build the core schema: `subject`, `subject_identifier`, `subject_merge`, `event`, `consent`, and `suppression`. Deliver `sendability()` with zero external dependencies. Build `lead-capture-gateway` to prove that anonymous web traffic with `fbclid` or `gclid` merges into an identified `subject` upon form submission.
- **Phase 2: Messaging Delivery & Approvals**. Implement `journey-engine` with a single Postgres polling worker, pinned `journey_version`, and the injectable `Clock` port. Integrate `@jini-ai/approvals` for message blast approvals. Deliver `message-dispatcher` connecting to Amazon SES and Twilio.
- **Phase 3: Conversion Tracking Bridge & Attribution**. Implement `conversion-tracking-bridge` to pipe conversion events to Meta CAPI and Google Enhanced Conversions, verifying that `suppression` and `consent` blocks drop tracking payloads before network transmission. Build the first deterministic multi-touch attribution queries in `attribution-engine`.
- **Phase 4: Paid Media Guardrails & Platform Connectors**. Implement `campaign-budget-governor`, the `campaign_budget_cap` table, the automated 15-minute kill-switch worker, and `ad-account-manager`. Connect Meta Marketing API and Google Ads API for campaign flighting.
- **Phase 5: Creative Production Pipeline & MCP Sandboxing**. Implement `creative_job` async polling, `mcp-sandbox-proxy`, and external MCP adapters for Higgsfield and Seedance. Connect asset ingestion to `asset-provenance-registry`.
- **Phase 6: Unified Desktop App & Canvas Integration**. Package `apps/server` as an autonomous background service supervised by `apps/desktop` via `@jini-ai/desktop-host`. Wire the three-pane UI (`LeftNav`, `CanvasView`, `AgentPane`) using `@jini-ai/chat` and `@jini-ai/ui`.

#### The First-Commit Tell
The first commit must contain **the core database migration creating `subject`, `subject_identifier`, `event`, `consent`, and `suppression`**, accompanied by a single test file: `packages/core/test/sendability-and-identity.spec.ts`. 

This test must instantiate an in-memory database using the injectable `Clock` port, simulate anonymous landing page tracking with a click identifier, execute a form capture that merges the click ID into a known `subject`, and pass that `subject` through `sendability(subject, 'email', 'marketing')` to verify that consent and suppression policies are evaluated correctly. If this file is missing, the project is drifting into decoupled, throwaway UI scaffolding.

---

### 7. The Structural Argument: One Product or Three?

Paid acquisition, creative production, and lifecycle messaging are not three independent products—they are a **single closed feedback loop linked by `subject_identifier` and fueled by asset rotation**. 

```
+-----------------------------------------------------------------------------+
|                               ONE CLOSED LOOP                               |
|                                                                             |
|   [1. Creative Production]                                                  |
|       Higgsfield / Seedance generate multi-aspect ratio assets              |
|       to overcome creative fatigue                                          |
|                                |                                            |
|                                v                                            |
|   [2. Paid Acquisition]                                                     |
|       Meta / Google Ads deploy creative, acquire anonymous traffic (gclid)   |
|                                |                                            |
|                                v                                            |
|   [3. Lead Capture & Identity Spine]                                        |
|       Landing page form binds gclid to subject_identifier & subject record  |
|                                |                                            |
|                                v                                            |
|   [4. Lifecycle Messaging]                                                  |
|       journey-engine nurtures contact via email/SMS into purchase event     |
|                                |                                            |
|                                v                                            |
|   [5. Server-Side Attribution & Conversion Feedback]                         |
|       CAPI sends purchase back to ad platform to optimize bidding algorithms|
|                                |                                            |
|                                +---> (Loop restarts with refined targeting) |
+-----------------------------------------------------------------------------+
```

You run paid ads with dynamic creative variations generated by external AI tools to overcome ad fatigue. Those ads drive anonymous prospects to landing pages, where `lead-capture-gateway` binds click identifiers (`fbclid`, `gclid`) to a newly generated `subject` record. Lifecycle journeys then nurture those contacts into purchasing customers. Finally, the resulting `event` row is dispatched by `conversion-tracking-bridge` directly back into Meta CAPI and Google Enhanced Conversions to train their bidding algorithms on which audiences generate real revenue. 

Slicing this loop into isolated tools breaks the feedback cycle: lifecycle software lacks ad attribution context, while standalone ad tools lack downstream customer lifetime value signals. 

However, **packaging this loop inside a desktop app is an architectural mistake**. While an Electron client is well-suited as an operator console (`apps/desktop`) for creative inspection and journey design, the execution engine (`apps/server`) must be an always-on, containerized server daemon. An autonomous marketing engine running server-side conversion webhooks, scheduled email journeys, hourly budget burn pacing, and platform kill-switches cannot go to sleep when a marketer closes their laptop lid.

---

### 8. The Biggest Thing That Will Go Wrong

The fatal operational failure will be **silent ad account suspension and unpacing triggered by the desktop-to-server lifecycle mismatch**. 

When an operator installs Open Marketing on a laptop, they will inevitably close the lid while high-budget Meta and Google campaigns are actively flighted. Because the local machine sleeps, the background `campaign-budget-governor` polling loop dies, severing real-time spend monitoring and halting the `conversion-tracking-bridge` event pipeline. Meanwhile, external ad networks continue spending heavily against outdated bids. Deprived of real-time CAPI feedback signals, their optimization algorithms begin bidding erratically. 

Simultaneously, the platform's automated compliance monitors flag the sudden divergence between server-side conversions and incoming traffic, triggering automated account suspensions for suspicious tracking anomalies. When the operator reopens their laptop on Monday morning, they will discover that thousands of dollars in budget were burned without conversion tracking, their primary Meta ad account is permanently disabled with no recourse, and their local SQLite/Postgres queue is clogged with hundreds of thousands of expired events that cannot safely be replayed without triggering downstream fraud bans.
