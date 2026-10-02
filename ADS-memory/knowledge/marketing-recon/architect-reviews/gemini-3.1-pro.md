Paid acquisition, lifecycle messaging, creative generation, and analytics constitute exactly one unified product, not three disparate systems. The architectural join forcing this unification is the `subject_identifier` traversing the boundary between an anonymous paid click (a Meta `fbclid` or Google `gclid`) and a known lifecycle email (a Formbricks form payload), persistently stored in the `subject_merge` Postgres table. Severing these domains breaks the Conversions API (CAPI) loop, rendering Customer Acquisition Cost (CAC) and Return on Ad Spend (ROAS) mathematically incalculable, and guarantees that the `sendability()` function will eventually violate the `consent` table by emailing a subject who opted out of paid tracking.

**1. The complete module list**

I agree with the premise that creative fatigue is the dominant treadmill of modern paid media. Therefore, generation is a core domain, not a peripheral side-feature. Furthermore, landing pages are treated as an integration, not a rebuilt module; Formbricks handles the DOM rendering, while Open Marketing handles the identity ingestion.

*   `identity-graph` (NEW): Owns the `subject`, `subject_identifier`, `subject_merge`, `consent`, and `suppression` Postgres tables. Marketing job: tracking who a person is across devices to prevent illegal remarketing and calculate true acquisition costs.
*   `lifecycle-engine` (NEW): Owns the `journey_run` table, the injected `Clock` port, the `FOR UPDATE SKIP LOCKED` Postgres poller, and the `sendability()` evaluator. Marketing job: executing multi-step email and SMS drip sequences over long time horizons.
*   `ad-bidder` (NEW): Syncs campaign budgets, bid pacing configurations, and custom audience hashed-email uploads to external ad network APIs. Marketing job: managing automated media spend and rotating ad creatives to combat fatigue.
*   `capi-ingestion` (NEW): Provides the server-side HTTP webhook endpoints that hash emails via SHA-256 and report offline conversions back to ad networks. Marketing job: training third-party ad algorithms on actual recorded sales rather than anonymous browser clicks.
*   `creative-forge` (NEW): Owns the `generation_job` table representing async tasks dispatched to external MCP endpoints, tracking required aspect ratios per platform. Marketing job: churning out image and video permutations to replace decaying ads.
*   `asset-dam` (NEW): Extends the Jini artifact system to store `s3://` or `file://` URIs, attaching a JSONB `provenance` column detailing the exact prompt, seed, and model used. Marketing job: providing a searchable brand repository of approved and compliant creative.
*   `attribution-ledger` (NEW): Owns the columnar tables joining platform-reported impressions with internal `event` tracking. Marketing job: proving which ad or email actually generated a sale.
*   `landing-pages` (NEW): Hosts React wrappers around Formbricks web-components, piping HTTP POST submissions directly into the `event` table. Marketing job: converting anonymous ad traffic into known email leads.
*   `@jini-ai/daemon`, `@jini-ai/agent-runtime`, `@jini-ai/protocol` (JINI): Consumed as-is for the tool-execution boundary, agent event log, and routine scheduler.
*   `@jini-ai/chat`, `@jini-ai/ui`, `@jini-ai/approvals` (JINI): Consumed as-is for the three-pane desktop surface (left nav, center canvas, right agent pane) and the durable pending-decision rows.
*   `Meta Ads API`, `Google Ads API`, `TikTok Ads API` (EXTERNAL): Ad network endpoints receiving our spend, pixel data, and audience configurations.
*   `Higgsfield`, `Seedance` (EXTERNAL): Third-party WebMCP endpoints rendering pixels from text prompts.
*   `Formbricks` (EXTERNAL): Form definition and rendering engine.

**2. The tool surface**

The tool surface exposed to the `@jini-ai/agent-runtime` must be coarsely grained to prevent gate fatigue. A human operator clicking a `@jini-ai/approvals` dialog fifty times to authorize individual nodes in a journey will quickly learn to rubber-stamp the prompt, turning the safety mechanism into theater. Approval gates are heavily batched.

Lifecycle tools:
*   `draft_journey(nodes, edges)`: Risk tier autonomous. Emits a `journey_version` record with a `draft` status, rendering the node graph in the center object canvas.
*   `estimate_audience(sql_segment)`: Risk tier autonomous. Executes read-only queries against the `attribute_definition` and `subject` tables to return a row count for the agent context.
*   `activate_journey(journey_version_id)`: Risk tier durable-approval. This is the batched gate. Approving this single Jini artifact commits the entire graph to the `journey_run` poller, bypassing the need to approve individual email dispatches.

Paid Media tools:
*   `draft_campaign_structure(ad_sets, targeting)`: Risk tier autonomous. Mutates local Postgres tables only, allowing the agent to structure the campaign before proposing spend.
*   `commit_ad_spend(campaign_id, budget_proposal)`: Risk tier durable-approval. The highest-risk gate in the system, authorizing external API calls that spend irreversible fiat currency.
*   `adjust_bids(campaign_id, adjustments)`: Risk tier autonomous. Allowed to execute without durable approval only if the pacing delta falls strictly within the `allowed_variance_percentage` of the parent `commit_ad_spend` artifact.
*   `halt_campaign(campaign_id)`: Risk tier autonomous. An automatic kill-switch the agent can pull if the `attribution-ledger` detects a collapsing ROAS anomaly.

Creative tools:
*   `dispatch_generation_jobs(prompts, aspect_ratios)`: Risk tier autonomous. Agent pushes payloads to the `creative-forge`, bounded entirely by a monthly API credit cap rather than human approval.
*   `attach_asset_to_ad(asset_id, ad_id)`: Risk tier confirm-in-run. Operator must visually verify the image in the Jini UI before it enters the creative rotation pool and syncs to the Meta Ads API.

Analytics tools:
*   `query_attribution(sql)`: Risk tier autonomous. Executes read-only queries against the `attribution-ledger` to feed performance data back into the agent's context window.

**3. Money and the irreversible boundary**

Ad spend represents a fundamentally irreversible boundary; unlike an incorrectly sent email which temporarily burns domain reputation, an incorrect bid parameter literally burns fiat currency via the Meta Graph API before anyone can intervene. Therefore, the `@jini-ai/capability-providers` module must treat ad credentials differently than typical integrations.

The OAuth tokens for external ad platforms reside strictly in the `apps/server` local encrypted `SecretStore`. The human operator authenticates once, but the Jini agent context never receives the plaintext token. When the agent constructs a `commit_ad_spend` tool call, it emits a `SpendProposal` JSON artifact containing `daily_cap`, `lifetime_cap`, and `allowed_variance_percentage`. This payload is routed to the `@jini-ai/approvals` queue.

When an operator clicks "Approve" in the Electron UI, the `apps/server` executes the state mutation against the ad platforms. For a campaign running for three weeks, the approval object pins the `lifetime_cap` for the full duration. The agent is granted autonomous permission to execute `adjust_bids` and rotate creatives within the ad sets, provided the resulting API payload does not breach the approved `lifetime_cap` limit. If the agent attempts a bid mutation exceeding the `allowed_variance_percentage`, the `apps/server` tool executor traps the request, downgrades the tool call to a `durable-approval` requirement, and throws a blocking prompt back to the Jini chat pane. The ultimate kill-switch is a hard-coded React component in the center canvas, permanently bypassing the agent runtime to issue synchronous `HTTP POST /{campaign}/pause` requests directly from the UI, guaranteeing the operator can stop spend even if the underlying LLM provider experiences an outage.

**4. Creative and MCP integration**

Creative generation jobs cannot be modeled as Jini runs or Temporal workflows. Generation via Higgsfield or Seedance over MCP is heavily asymmetric, often taking minutes per asset and failing non-deterministically. Using a Jini run blocks the agent daemon loop; using the `journey_run` table conflates human subject routing with system task queues.

Instead, the `creative-forge` implements a distinct `generation_job` Postgres table. The agent invokes `dispatch_generation_jobs`, which inserts a row with a `pending` status. A dedicated Node.js `setInterval` poller in `apps/server` picks up the row and executes the WebMCP invocation. Upon completion, the image bytes are streamed into the local filesystem, and the URI is registered in the `asset-dam` module. Crucially, the `@jini-ai/artifacts` table is augmented here with a JSONB `provenance` column storing the exact `prompt`, `seed`, and `mcp_server_id` used. This guarantees that successful assets can be deterministically mutated later when ad fatigue sets in, allowing the agent to request a "10% variant of asset_id 849" rather than starting from scratch.

The trust boundary for external MCP servers is absolute network isolation. Third-party MCP servers like Seedance are black boxes executing prompts. To prevent a compromised external MCP from executing prompt-injection attacks that traverse back into the Open Marketing host and calling `commit_ad_spend`, the Jini `sandbox` must enforce namespace restriction. The `creative-forge` tool executor drops all ambient credentials before initiating the WebMCP TCP connection, ensuring the remote server can only return `image/png` bytes and cannot access the `capability-providers` token store or the internal Postgres socket.

**5. Analytics truth model**

The analytics truth model requires two distinct stores, acknowledging the reality that third-party ad platforms and internal delivery ledgers will never reconcile. The prior "Postgres until measurably too slow" rule applies perfectly to the `lifecycle-engine` and the `identity-graph`. The `message_delivery` table and the `event` table (capturing Formbricks submissions and Stripe checkouts) live entirely in Postgres. This is the deterministic first-party ledger, operating with row locks and ACID guarantees.

However, the `attribution-ledger` strictly requires ClickHouse. Meta and Google do not report deterministic, un-sampled user journeys; they provide aggregated, frequently restated impression and click streams spanning millions of rows per day. Attempting to execute a rolling 28-day multi-touch attribution window—joining Meta's hashed `fbclid` clickstream against the Postgres `subject_merge` table to calculate ROAS on a per-ad-set basis—will force sequential table scans that lock the `apps/server` database and halt the `journey_run` poller.

ClickHouse operates as the read-only analytical sink. The `apps/server` tails the Postgres WAL (Write-Ahead Log) via logical replication to stream `event` and `subject_merge` mutations into ClickHouse `MergeTree` tables. Simultaneously, the `ad-bidder` fetches nightly ad performance reports and dumps them into ClickHouse. The agent's `query_attribution` tool strictly issues SQL against ClickHouse, never Postgres. The Jini UI explicitly visualizes the discrepancy, rendering a dashboard with "Platform Reported Conversions" pulled from network APIs alongside "Ledger Attributed Conversions" calculated via ClickHouse joins, explicitly abandoning any attempt to force the two numbers to match.

**6. Build order**

The build order must aggressively de-risk the `subject_identifier` join and the `FOR UPDATE SKIP LOCKED` dispatcher before touching LLM generation or ad spend.

*   Phase 1: The Data Spine. This establishes the `identity-graph` and the core schema. The first-commit tell is `migrations/001_initial_spine.sql` containing the `subject`, `subject_identifier`, `event`, and `consent` tables, alongside the PL/pgSQL implementation of the `sendability(subject, channel, purpose)` function. Its accompanying artifact must be a unit test passing in an injected `Clock` dependency to verify suppression windows without executing sleep commands.
*   Phase 2: Jini Surface Integration. Linking `@jini-ai/daemon` and `@jini-ai/chat` within the `apps/desktop` Electron shell, ensuring the sidecar accurately supervises the `apps/server` process lifecycle and renders the three-pane UI.
*   Phase 3: Lifecycle Engine. Implementing the `journey_run` poller and connecting the `sendability()` evaluator to Amazon SES and Twilio dispatch adapters.
*   Phase 4: Paid Media and CAPI. Implementing the `ad-bidder` to sync campaign budgets, followed immediately by the `capi-ingestion` webhooks to close the ROAS loop.
*   Phase 5: Creative Forge. Connecting Higgsfield and Seedance MCPs, backed by the `generation_job` poller and the `asset-dam` extensions to `@jini-ai/artifacts`.
*   Phase 6: ClickHouse Analytics. Standing up the logical replication from Postgres and implementing the attribution query generation.

**7. The biggest thing that will go wrong**

The fatal architectural flaw in this design is the decision to deliver Open Marketing as an `apps/desktop` Electron application, which directly contradicts the operational requirements of the `capi-ingestion` module. Modern paid media relies entirely on Server-Side Tracking because browser pixels are dead. This requires external services like Shopify or Stripe to fire HTTP webhooks to the Open Marketing server the exact moment a conversion happens, so Open Marketing can hash the `subject_identifier` and forward it to Meta. If Open Marketing's server component only runs as a sidecar process supervised by a laptop's Electron host, those inbound webhooks will hard-bounce with 503 errors the moment the user closes their laptop lid, sleeps their machine, or rotates their home IP address. Meta's ad algorithm severely penalizes ad sets with dropping conversion signals, causing Cost Per Acquisition (CPA) to skyrocket. To survive, the `apps/server` Docker container must be extracted from the desktop paradigm entirely and deployed to a persistently available VPS or PaaS, relegating the `apps/desktop` Electron app to a mere remote-control client for a cloud-hosted marketing engine.
