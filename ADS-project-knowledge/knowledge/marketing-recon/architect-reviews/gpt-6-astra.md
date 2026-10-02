Open Marketing is **one product with several bounded domains**: `ad → landing_page → subject_identifier → journey → purchase → conversion_export`. Paid acquisition creates relationships that lifecycle messaging monetizes; creative production replenishes acquisition. I agree that creative refresh can differentiate the product. Building four complete ad adapters simultaneously would undermine that advantage. Electron remains the operator console; production forms, callbacks, and spending supervision require the always-on Docker server. A sleeping laptop cannot supervise an active ad account.

The module inventory below separates product ownership from reusable Jini mechanisms.

| Module | Classification | Owns |
|---|---|---|
| Server composition | NEW | `apps/server`: API, public endpoints, workers; product packages never import desktop code. |
| Operator console | NEW | `apps/desktop`: left navigation, center object canvas, collapsible Jini agent; generated objects open as drafts. |
| Workspace administration | NEW | Workspaces, brands, users, roles, account access, onboarding, credential connections. |
| Identity spine | NEW | `subject`, `subject_identifier`, `subject_merge`, `attribute_definition`; verified identity and merge history. |
| Permission and privacy | NEW | `consent`, `suppression`, `sendability()`, export policy, preference center, retention, erasure requests. |
| Ingestion and connectors | NEW | `event`, import mappings, webhook inbox, deduplication, cursors, CRM/commerce synchronization. |
| Commerce context | NEW | Products, offers, orders, refunds, revenue and margin; defines what campaigns sell. |
| Campaign planning | NEW | `campaign`, objectives, calendar, owners, linked messages, ads, destinations, creative briefs. |
| Segmentation | NEW | Versioned segment expressions, membership, audience estimates, exclusions, lifecycle targeting. |
| Message authoring | NEW | Email/SMS templates, localization, personalization, shared preview/dispatch `render()`. |
| Message delivery | NEW | `message_delivery`, transactional outbox, provider attempts, idempotency, retries, throttling. |
| Journey execution | NEW | Immutable `journey_version`, `journey_run`, `resume_at`, `wait_event`, injectable `Clock`, Postgres poller. |
| Deliverability | NEW | Sender domains, authentication checks, warmup, bounces, complaints, frequency limits, SMS quiet hours. |
| Landing pages and forms | NEW | `page_version`, `form_version`, `form_submission`, publication, domains, validation, spam protection. |
| Acquisition tracking | NEW | Anonymous visits, UTMs, click identifiers, redirect links, consent-aware identifier attachment. |
| Conversion feedback | NEW | `conversion_destination`, `conversion_export`, delivery receipts, deduplication, corrections, permission checks. |
| Paid campaign model | NEW | `ad_account`, `ad_campaign`, `ad_group`, `ad`, native extensions, desired/observed state. |
| Paid platform adapters | NEW | Meta/Google/TikTok/LinkedIn translation, capabilities, review status, suspension handling, drift detection. |
| Platform audiences | NEW | `audience_sync`, custom-audience membership, lookalike specifications, permission-filtered additions/removals. |
| Spending controller | NEW | `spend_authorization`, reservations, pacing, bid bounds, native limits, emergency pause. |
| Brand and creative briefs | NEW | Brand rules, reference assets, approved claims, copy, creative concepts and required placements. |
| Generation orchestration | NEW | `generation_job`, attempts, provider handles, cost reservations, cancellation, reconciliation. |
| Asset library | NEW | `asset`, immutable `asset_version`, provenance, rights, licenses, releases, usage references. |
| Rendition production | NEW | `rendition_recipe`, crops, aspect ratios, captions, encoding, placement validation. |
| Creative performance | NEW | Creative families, fatigue signals, replacement queues; keeps campaigns supplied with fresh concepts. |
| Experimentation | NEW | Randomized assignments, holdouts, exposure records, stopping rules; tests incremental marketing value. |
| Analytics ingestion | NEW | Versioned platform metric snapshots, reporting windows, restatements, currency and timezone normalization. |
| Attribution | NEW | `touchpoint`, `conversion`, `attribution_run`, versioned models and credited contributions. |
| Reporting | NEW | Campaign dashboards, cohorts, CAC, ROAS, LTV, report exports, ledger reconciliation. |
| MCP trust gateway | NEW | Approved servers, pinned schemas, scoped invocation, egress restrictions, secret references. |
| Command authorization and audit | NEW | Server-side policy, revision-bound commands, actor identity, append-only decision/execution records. |
| Durable decisions | NEW | Proposed product-neutral `@jini-ai/approvals`: pending decisions, expiry, revocation, authenticated UI/CLI resolution. |
| Operations | NEW | Worker leases, dead letters, connector health, alerts, backups/restores, migrations, desktop updates. |
| Agent execution | JINI | `@jini-ai/protocol`, `daemon`, `agent-runtime`, `sqlite`: runs, CLI execution, durable runtime events. |
| Agent interaction | JINI | `@jini-ai/chat`, `ui`, `agentic`: chat components, capability vocabulary, agent-addressable controls. |
| MCP and discovery | JINI | `@jini-ai/mcp`, `registry`: protocol/configuration/authentication and registry primitives. |
| Agent context | JINI | `@jini-ai/memory`, `tokens`: scoped context and token accounting. |
| Host and infrastructure ports | JINI | `@jini-ai/desktop-host`, `core`, `http-kit`, `capability-providers`: host lifecycle, composition, HTTP, auth/blob ports. |
| Artifact/content primitives | JINI | `@jini-ai/artifacts`, `cms`: manifests, publication guards, reusable content mechanisms. |
| Sandbox and CLI | JINI | `@jini-ai/sandbox`, `cli`: execution ports and operator CLI infrastructure. |
| Transport providers | EXTERNAL | Email/SMS gateways and Meta, Google, TikTok, LinkedIn APIs. |
| Creative providers | EXTERNAL | Higgsfield/Seedance-class services through vetted MCP adapters; capabilities verified per provider. |
| Business integrations | EXTERNAL | CRM, commerce, payment-event sources; optional Formbricks survey/form service. |
| Data/publication infrastructure | EXTERNAL | Postgres, S3-compatible blobs, DNS/TLS/CDN; independently deployable dependencies. |

Agent tools expose product commands, never unrestricted provider mutations. **A** means autonomous within existing authorization; **C** means confirm-in-run; **D** means durable approval. Every mutation passes the same server policy as the canvas.

| Tool group | Calls and risk |
|---|---|
| Objects and planning | **A:** `campaign.create_draft`, `object.get`, `object.update_draft`, `campaign.simulate`. |
| Identity and audiences | **A:** `subject.inspect`, `segment.define`, `segment.estimate`; **D:** `identity.merge_batch`, `privacy.erase_batch`, `subjects.export`. |
| Messaging and journeys | **A:** `message.render`, `journey.simulate`, `delivery.inspect`; **C:** `message.send_test` to allowlisted recipients; **D:** `campaign.activate`. |
| Destinations | **A:** `page.draft`, `form.preview`; **D:** `destination.publish_bundle`. |
| Paid media | **A:** `ads.inspect`, `ads.plan`, `ads.adjust_within_authorization`, `ads.pause`; **D:** `ads.activate`, `spend.amend`. |
| Customer-data sharing | **A:** `conversion.validate`, `feedback.inspect`; **D:** `sharing.authorize_destination`, `audience.authorize_sync`. |
| Creative | **A:** `asset.search`, `creative.brief`, `generation.quote`, `generation.submit_within_allowance`, `rendition.create`; **D:** `creative.authorize_batch`. |
| Analytics | **A:** `metrics.query`, `attribution.compare`, `report.create`, `experiment.design`; **D:** externally active experiment allocation. |
| Administration | **A:** `connector.health`, `operations.inspect`; **C:** discard draft edits; **D:** connect servers, widen credentials, change policy. |

One campaign approval batches messages, journey version, destinations, audience rules and launch schedule. One creative approval covers a generation allowance and a reviewed replacement pack. One destination authorization covers recurring conversion exports under specified fields and purposes. Recipients, retries, renditions and permitted rotations do not trigger individual gates. The agent can request approval; it cannot resolve its own decision.

Sending crosses an irreversible boundary once per delivery. Advertising crosses that boundary continuously after activation. A three-week `spend_authorization` contains immutable campaign revision, account/currency, start/end/timezone, $2,100 maximum liability, platform allocations, pacing targets, bid-strategy bounds, targeting, approved creative pool, conversion objective, monitoring requirements, approver and revocation state. Generation expenditure has a separate ceiling.

Reserve campaign liability against the workspace budget transactionally before activation. Create platform objects paused, install supported native caps/end dates, read them back, then activate. The server credential vault releases account-scoped credentials only to trusted adapter workers. Agent adjustments may redistribute approved allocations, rotate approved assets and change bids within bounds; they cannot expand targeting, extend dates, raise total liability or resume an emergency-paused campaign.

**Pacing is not a hard cap.** Google explicitly allows daily overdelivery against an average daily budget. Adapter capabilities must distinguish enforceable limits from estimates. Where native controls cannot bound the approved liability, refuse strict-cap unattended activation. Poll spend and configuration, reserve for unsettled liability, stop early for latency, and pause on stale telemetry. A durable kill-switch queues platform pauses and verifies observed status; an API outage means “pause unconfirmed,” never “stopped.” Native limits remain the protection during server failure. [Google’s budget semantics](https://support.google.com/google-ads/answer/1704424?hl=en)

`packages/conversion-feedback` belongs beside identity and paid adapters on the server. It exports a destination event ID, occurrence time, event type, value/currency, eligible click identifiers and only permitted customer fields, normalized/hashed as the platform requires. Browser/server duplicates share the destination deduplication key. Google’s conversion interface explicitly supports hashed identifiers and consent metadata. Server-side reporting complements browser tracking; it does not restore missing permission. [Google conversion imports](https://developers.google.com/google-ads/api/docs/conversions/upload-offline)

Use `exportability(subject, destination, purpose, fields)` over the same consent/suppression records, with capture-time evidence and a fresh dispatch check. Email unsubscribe does not automatically mean every advertising purpose is prohibited; purpose-specific withdrawal does. Unknown authorization blocks identifying exports. Withdrawal cancels queued exports, removes audience membership and schedules supported deletion requests. Hashes remain identifying data; downstream deletion has recorded acknowledgments and limitations.

Build native landing-page templates and lead forms because `form_submission → subject_identifier` is the acquisition/lifecycle join. Preserve permitted UTMs and click references, collect purpose-specific consent, verify identifiers, and never merge people merely because they share a browser. Integrate Formbricks through webhooks for richer surveys; do not adopt its contact database as the identity spine. [Formbricks webhook interface](https://formbricks.com/docs/api-reference/management-api--webhook/create-webhook)

Creative production is a **small DAM**, backed by Postgres metadata and tenant-scoped, content-addressed blob keys. Store prompt, provider/model/version, seed when supplied, source versions, terms snapshot and rights evidence. Jini’s `ArtifactStore` supplies `create/get/list`, manifests and guards; it does not supply this version/rights model. [Jini artifact interface](/Users/la/Programming/Jini/packages/artifacts/src/store.ts:104)

Generation uses a separate `generation_job` queue with the journey poller’s lease mechanics and independent concurrency limits. Persist provider job IDs, reservations, attempts, deadlines and result hashes. Reconcile ambiguous submissions before retrying charged work. Jini runs initiate and observe jobs; jobs survive those runs. Placement recipes generate required variants without hard-coding “six.” Fatigue signals combine frequency, exposure and performance trends; minimum samples and holdouts prevent random variation from exhausting the creative allowance.

The MCP registry records endpoint or image digest, schema hash, publisher, allowed tools, data classes, credential scopes, destinations and cost limits. Run local servers and agent CLIs without inherited secrets, database access or unrestricted network access. Remote generators receive only selected inputs and expiring asset URLs. Validate returned files and URLs against malware, SSRF and size limits. Tool descriptions/results remain untrusted data. Account credentials and authorization endpoints are inaccessible from the creative sandbox; prompt injection cannot mint additional authority. Jini provides primitives; Open Marketing must implement and test this isolation. [MCP security guidance](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)

Use **one Postgres deployment, two explicit accounting views**, plus blob storage. First-party delivery/outcome facts reconcile to their ledgers through idempotent ingestion and rebuildable aggregates. Platform observations retain source, window, reporting timezone, fetch time, revision and sampling/modeling flags. Platform conversions cannot reconcile to first-party attributed conversions; never sum their claims. Reconcile billed spend separately from reported served cost.

Attribution lives in a versioned product module with an explicit unattributed bucket and refund adjustments. Preserve anonymous aggregate contributions before erasing identifiers and join edges; persistent hashes are not anonymous history. Reports disclose that historical person-level attribution cannot be reconstructed after erasure. Postgres partitions, incremental aggregates and indexes come first. Add ClickHouse only after measured ingestion or query SLO failures; it would be a rebuildable analytical projection.

Build the complete loop in these phases:

1. **Foundation:** workspace boundary, Postgres spine, `Clock`, command policy, approvals, outbox and object canvas.
2. **Owned acquisition:** forms, identity attachment, consent, email, journeys, order/refund ingestion and ledger reports.
3. **Paid acquisition:** one Meta adapter, native limits, audience permissions, conversion feedback and pause verification.
4. **Creative replenishment:** DAM, one MCP generator, async jobs, rendition recipes, reviewed rotation and fatigue diagnostics.
5. **Expansion:** Google/TikTok/LinkedIn, SMS, experiments, advanced attribution, operational hardening.

The first-commit tell is `packages/product/tests/acquisition-loop.contract.test.ts`, executable with fake adapters and `FakeClock`: form submission creates identity; withdrawal blocks send/export; concurrent campaigns cannot over-reserve money; expired authorization prevents activation.

The biggest failure will be an optimizer that makes platform ROAS look better while customer economics deteriorate. Duplicate conversions, missing refunds and weak creative experiments will reward cheap leads; the agent will scale those audiences and generate more variants for them. The resulting `campaign` dashboard will look productive while contribution margin falls. Require qualified outcomes, refund-aware revenue and holdouts before granting autonomous budget reallocation.
