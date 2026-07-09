# ROADMAP

Architecture: Ground-up rewrite of marketing automation on Open Design's plugin/daemon/web foundation. Mautic is a domain reference only (codebase-memory-mcp graph for querying entity models, workflows, edge cases). No PHP. No Mautic runtime.

## The Marketing Workflow (what a user actually does)

### The Loop

1. **Research** — Who's my audience? What do competitors do? What channels work for my vertical?
2. **Strategize** — Set goals (awareness / leads / sales / retention), pick channels, set budget, define timeline
3. **Define offer/positioning** — Value prop, proof points, objections, pricing/promo, CTA. Marketers don't just "write ads" — they define what they're selling and why anyone should care.
4. **Segment** — Define who gets what message AND who to exclude (existing customers, employees, recent converters, low-quality segments)
5. **Create** — Write copy, design ads, build landing pages, record video, draft emails. Generate creative variants for testing.
6. **Build campaign** — Wire up the workflow: campaign structure (ad sets/groups, placements, bidding), triggers, conditions, timing. Define experiment design (holdouts, test duration, confidence thresholds).
7. **Measurement planning** — Define KPIs, conversion events, attribution windows, UTM naming conventions, budget guardrails, success thresholds. Set up tracking (pixels, server-side events, CAPI).
8. **Tracking QA** — Verify pixels fire, conversion events register, UTMs are correct, landing pages load, forms submit. Without this, "monitor" is vanity metrics.
9. **Approval gate** — Brand review, legal sign-off, spend authorization. Platform policy check (ads get rejected — need handling workflow).
10. **Launch** — Push live across channels with compliance checks, budget pacing rules active.
11. **Monitor & optimize** — Watch metrics in real-time, pause underperformers, shift budget to winners, handle policy rejections, manage learning phase, detect creative fatigue.
12. **Report** — Weekly/monthly: what worked, what didn't, ROI per channel, spend vs. pipeline, recommendations. Exportable for executives.
13. **Archive & post-mortem** — Campaign ends. Extract learnings (winning creative, best audience, best timing). Feed into brand memory for next Research phase.
14. **Iterate** — Refine segments, refresh fatigued creative, scale winners, kill losers. Loop restarts.

This loop runs continuously. A mature marketing team has 5-20 campaigns active simultaneously at different stages.

### Platform Capabilities (ambient, supporting the loop)

These aren't steps — they're infrastructure that makes the loop faster:

- **Contact/audience database** — System of record for contacts. Identity resolution: anonymous visitor → lead → contact → account → opportunity → customer.
- **Template/asset library** — Reusable templates, brand kits, image libraries. Creative lineage tracking (which prompt/model/brief produced what, how it performed).
- **Compliance/consent** — GDPR, CAN-SPAM, CCPA checks at launch/send time. Suppression lists synced across all channels.
- **Scheduling/calendar** — Content calendar, timezone-aware sends, campaign coordination, budget pacing.
- **Collaboration/approvals** — Multi-role workflows. Every AI action touching spend needs approval, diff preview, audit log, rollback.
- **Analytics/attribution** — Multi-touch attribution. Conversion events, server-side tracking, identity graph.
- **Reporting/dashboards** — Automated rollups. Drives the data model — not a bolt-on.
- **Measurement infrastructure** — Pixels, Meta CAPI, Google Enhanced Conversions, UTM governance, event ingestion pipeline.
- **Spend safety** — Budget caps, anomaly detection, kill switches, account-level limits, pacing alerts.
- **Frequency capping & suppressions** — Prevent ad fatigue, exclude wrong audiences, cap cross-channel exposure.

### What Open Marketing adds (the AI layer)

The killer feature is NOT "generate copy" — everyone has that.

The killer feature is: **an AI operator that finds what is wasting money, explains why, proposes specific changes, predicts impact, and executes after approval.**

Examples:
- "This ad set is spending 42% of budget but has 0 qualified pipeline. Pause it?"
- "Creative fatigue started 3 days ago. Here are 5 replacement variants using the winning hook."
- "Search terms show irrelevant intent. Add these 18 negative keywords."
- "CPA is up because conversion rate dropped on the landing page, not because CPC increased."
- "Weekly exec report: spend, pipeline, CAC, ROAS, what changed, what we'll do next."

Platform capabilities:
- **AI agents execute each step** — 20 skills + 7 specialists as performance analyst + media buyer + creative strategist + reporting assistant
- **Multi-LLM creative** — Copy, images, video via any model (open source, Claude, Gemini, OpenAI)
- **MCP connectors** — Google Ads, Meta, LinkedIn, Reddit, TikTok, email providers — unified in one place
- **Agentic UI** — Forms autofilled, campaigns suggested, budgets optimized, approvals routed (A2A, MCP-UI, Web-MCP)
- **Autonomous optimization** — Detects fatigue, drafts replacements, proposes budget shifts, sends approval request
- **Predictive forecasting** — "If you increase budget by $5k, we predict 45 more leads at $110 CPA"
- **Chat-to-analytics** — Ask "why did CPA spike in California yesterday?" and get a chart + hypothesis
- **User-extensible** — Add your own skills, agents, connectors
- **Direct spend management** — With audit trails, permissions, budget limits, and rollback

---

## Domain Knowledge (things that affect platform design)

**The Funnel is everything.** Marketers think in stages: Awareness → Interest → Consideration → Intent → Purchase → Loyalty. Every piece of content, every campaign, every metric maps to a funnel stage. The platform needs funnel-awareness baked into every feature — not as a visualization, but as the organizing principle for contacts, campaigns, and reporting.

**Nobody uses one channel.** A single "campaign" might be: Facebook ad → landing page → email drip (5 emails over 14 days) → retargeting ad on Google → sales call. These are orchestrated, not independent. The campaign engine is the most complex service to build.

**Creative fatigues.** Ads stop working after people see them 3-7 times. Marketers need to constantly refresh creative — this is where AI generation is a massive unlock. But they need to know WHEN to refresh (frequency/fatigue metrics) not just how.

**Deliverability is a dark art.** Email doesn't just "send." You need: domain authentication (SPF, DKIM, DMARC), IP warming (send slowly from new IPs or you get spam-flagged), bounce handling, spam score checking, inbox placement testing. Send 10,000 emails wrong and your domain is blacklisted for months.

**Attribution is the hardest unsolved problem.** A customer saw your blog post, then an ad, then got an email, then Googled you, then bought. Who gets credit? Every model (first-touch, last-touch, linear, time-decay, data-driven) gives a different answer. Multi-touch attribution is why analytics tools cost $50k+/year.

**Segments are dynamic, not static.** "People who visited the pricing page in the last 7 days but haven't bought" — that list changes every minute. Segments are live queries against behavior data, not saved lists.

**Lead scoring determines who gets human attention.** Scores go up for: opened email (+5), visited pricing page (+20), downloaded whitepaper (+15), is VP-level (+25). When score hits threshold → alert sales team. Critical for B2B.

**Timing matters more than content.** The same email sent at 9am Tuesday vs. 3pm Saturday can have 4x engagement difference. Timezone-aware send-time optimization is table stakes.

**Marketers live in spreadsheets and reports.** They present to executives weekly. If the platform can't export a clean PDF/deck showing spend vs. return, they'll export to Google Sheets anyway. Reporting is how marketers justify their budget (and jobs).

**Compliance isn't optional — it's existential.** GDPR fines are up to 4% of global revenue. CAN-SPAM is $50k per violation. Platform needs: double opt-in flows, one-click unsubscribe (legally required since Feb 2024), consent records with timestamps, data deletion on request, suppression lists that sync across all channels.

**The real competition isn't Mautic.** It's HubSpot ($60-3600/mo), Marketo (enterprise), Klaviyo (e-commerce), ActiveCampaign, Brevo. Each owns a niche. Our differentiation: open-source + AI-native + extensible. Nobody else has agent-driven marketing automation.

**Identity resolution is the glue.** A user is: anonymous cookie → mobile device ID → email → CRM contact → account → opportunity → customer. Without stitching these together, multi-touch attribution and cross-channel orchestration break.

**Measurement infrastructure is the nervous system.** Conversion events, pixels, server-side tracking (Meta CAPI, Google Enhanced Conversions), UTM governance, campaign naming taxonomies. Without this plumbing, "analytics" is just vanity metrics.

**Platform rejections are operationally central.** Ads get rejected, limited, stuck in review, or policy-flagged. The platform needs workflows for handling this — not just "launch and hope."

**Bidding strategies matter.** Marketers set targets: tCPA (target cost per acquisition), tROAS (target return on ad spend). The platform needs to understand learning phase constraints and algorithmic delivery.

**Over-normalizing platforms will fail.** Google Ads and Meta Ads are fundamentally different products (search intent vs. visual discovery). Connectors need common contracts PLUS platform-specific extensions.

---

## Architectural Decisions (adapter-based, decide implementation later)

These need to be designed upfront but implementation choice deferred behind adapters:

| Concern | Options | Adapter Strategy |
|---------|---------|-----------------|
| Event pipeline | Kafka, Redis Streams, NATS, Postgres LISTEN/NOTIFY | `EventBus` interface — start simple, swap to streaming when scale demands |
| OLAP / metrics store | ClickHouse, TimescaleDB, DuckDB, plain Postgres | `MetricsStore` interface — query abstraction over time-series data |
| Workflow state machine | Temporal, Inngest, BullMQ, custom | `WorkflowEngine` interface — "wait 2 days then do X" needs durable execution |
| Identity resolution | Custom graph, built-in merge logic | `IdentityResolver` interface — merge rules for stitching anonymous → known |
| RBAC / permissions | Casbin, custom role system, ABAC | `PermissionEngine` interface — user-extensible agents + spend access = security critical |
| Reporting / export | Custom + PDF generation, embedded BI (Metabase), API | `ReportRenderer` interface — multiple output formats (PDF, CSV, dashboard) |
| Creative generation | Claude, Gemini, OpenAI, open-source models | Already adapter-based via multi-LLM skills |
| Ad platform connectors | Direct API, MCP servers | `ChannelConnector` interface with platform-specific extensions |
| MCP authentication | OAuth 2.0, ScaleKit, Google Auth, custom | `AuthProvider` interface — needed for Web-MCP and any external MCP server connections. OAuth as protocol, provider TBD (ScaleKit paid, Google Auth free). Not MVP — required when Web-MCP lands (v3+) |

Design the interfaces in Phase 1 contracts. Pick the simplest local-first implementation for MVP: SQLite for structured state, SQLite FTS5 for tool search when available, in-process/background jobs where durable scheduling is not yet required, and custom permission checks. Swap later when scale demands without rewriting domain logic.

---

## AI Strategy (Swarm Consensus, 2026-06-25)

### AI Architecture — Single Recommendation Pipeline

NOT separate "engines." One pipeline with capabilities as internal modules:

```
Observe → Analyze → Draft → Screen → Recommend → (Approval Gate) → Execute → Measure
```

| Capability | What it does | Implementation |
|-----------|-------------|----------------|
| **Generate** | Structured variant generation (hooks × bodies × CTAs), copy remixing | LLM call with structured output |
| **Analyze** | Fatigue detection, funnel diagnosis, causal analysis, anomaly detection | LLM + deterministic threshold checks |
| **Screen** | Pre-check creative against platform ad policies before submission | Lightweight classifier / LLM prompt |
| **Decide** | Propose state changes with evidence, confidence score, and dry-run diff | LLM reasoning + rule engine |
| **Remember** | Brand voice, past winners/losers, audience learnings, creative lineage | RAG / vector store + structured metadata |
| **Forecast** | Budget → predicted leads/CPA (v2) | Statistical model + LLM interpretation |

### AI Authority Model (5-Tier Risk)

| Tier | AI can... | Example | Approval? |
|------|-----------|---------|-----------|
| **Observe** | Pull metrics, summarize, report | Dashboard refresh, anomaly detection | None |
| **Draft** | Generate copy, replacements, reports | Variant generation, weekly report | None |
| **Recommend** | Propose action with evidence + dry-run diff | "Pause this ad set — here's why" | User reviews |
| **Execute constrained** | Pre-approved reversible actions under limits | Pause/resume, budget-down within cap | Pre-authorized |
| **Blocked** | Cannot do without explicit human action | Launch, budget increase, delete, special-category | Always blocked |

Every action in tiers 3-4 requires: dry-run diff preview, confidence score, evidence chain, audit log entry, and rollback path.

### Tech Stack (layered)

1. **Tool/Action layer** — MCP connectors (Meta Ads API, analytics, CRM) + internal typed domain actions (`pauseAdSet`, `generateVariants`, `proposeBudgetShift`)
2. **Workflow layer** — Campaign jobs, schedules, approvals, retries, audit logs. Event-triggered AND metric-triggered (not just cron).
3. **UX layer** — Dashboard (primary) + CopilotKit/AG-UI (inline creation assist) + Chat (ad-hoc queries)
4. **Governance layer** — Permissions, spend limits, policy gates, human approval, budget caps, kill switches

### UX Paradigm (hybrid, prioritized)

1. **Dashboard-first** — Performance metrics, alerts, pending approvals, AI recommendations with confidence scores
2. **Copilot-second** — Inline help while building offers, ads, audiences, reports (CopilotKit/AG-UI)
3. **Autonomous-with-approval** — Background monitoring, draft recommendations, safe auto-actions under strict limits
4. **Chat as command layer** — "Why did CPA spike?", "Make 5 variants of this hook", "Show me last week's winners"

### AG-UI Copilot Page Workflow

Use CopilotKit/AG-UI as the page assistant for every campaign workflow page. The assistant should know where the user is, what entity is being edited, which fields are visible, and which safe actions are available.

Each page exposes a context snapshot to the copilot:

```ts
{
  page: "campaign_brief",
  campaignId: "cmp_123",
  step: "brief",
  fields: [
    { name: "goal", label: "Goal", value: "Get beta users", required: true },
    { name: "budget", label: "Budget", value: "$50/day", required: true }
  ],
  availableActions: [
    "summarize_current_page",
    "fill_campaign_brief_field",
    "validate_campaign_brief",
    "save_draft",
    "go_to_next_step"
  ]
}
```

The AI should not click arbitrary UI controls. It should call typed domain actions that the page and daemon expose. Page-local tools handle form work; global tools handle cross-page/searchable capabilities.

Page-local tools:
- `summarize_current_page`
- `fill_<page>_field`
- `validate_<page>`
- `save_draft`
- `go_to_next_step`
- `request_approval`

Global searchable tools:
- `search_tools(query, page, channel, riskTier)`
- `get_tool(toolId)`
- `run_tool(toolId, args)` only for permissioned, audited actions

SQLite is sufficient for the first implementation. Store the registry and audit trail locally:

```text
marketing_tools
marketing_page_tools
marketing_tool_runs
marketing_form_drafts
marketing_approvals
marketing_audit_log
```

Use SQLite FTS5 for local tool search when available:

```text
marketing_tools_fts(name, description, tags, input_schema_json)
```

This allows the assistant to answer "what can I do on this page?", fill specific fields, navigate the campaign pipeline, and discover other tools without requiring a vector database or Web-MCP.

### Form Strategy

Campaign workflow forms should be automation-friendly: typed field names, schema-backed validation, explicit save/validate/next actions, and no hidden DOM-only state.

Use `@tanstack/react-form` for new campaign workflow forms unless the repo standardizes elsewhere first. It is headless and TypeScript-first, so it can work with the repo's existing `@open-design/components` controls while exposing a clean API for AI-assisted field updates.

Pattern:

```ts
form.setFieldValue("goal", aiValue)
```

or through a page action:

```ts
fillCampaignBriefField({ field: "goal", value: "Get beta users in LA" })
```

Do not automate form filling by querying DOM selectors. The AI should update structured form state and let the form renderer display it.

### Web-MCP Decision

**Do NOT tag every UI component.** Instead: expose intent-based typed actions with audit logs. AI calls domain actions (`createCampaignDraft`, `validateTracking`, `requestLaunchApproval`), not UI buttons. Components can advertise contextual affordances to the copilot, but execution goes through permissioned action APIs with dry-run previews.

Web-MCP reserved for v3+ — useful when users build custom dashboards/forms and want AI to assist with filling them. Not needed for Meta Ads MVP. Requires MCP authentication stack (OAuth 2.0 as protocol, provider options: ScaleKit, Google Auth, or custom) to secure AI-on-behalf-of-user actions.

### A2A / MCP-UI

- **A2A** — Defer to v2. Get one agent loop working reliably first.
- **MCP-UI** — Useful for structured approval/clarification moments (e.g., AI asks "which audience do you prefer?" with options). Scope to approval flows only, not universal UI substrate.

### Voice AI & SMS

- **Voice AI (missed calls)** — v3+. Sales/lead-response feature for service businesses. Not Meta Ads scope.
- **SMS** — v2. Real channel for lifecycle marketing (abandoned cart, reminders). Fits naturally into channel dispatcher.

### Critical MVP Automation Patterns

1. **Daily spend pacing** + anomaly alerts (overspend/underspend)
2. **Creative fatigue detection** → draft replacements → human approval (respects learning phase)
3. **Underperformer detection** → propose pause (ad set spending with 0 conversions beyond learning phase)
4. **Winner extraction** — "this hook/audience/offer is working" → recommend scale (human executes budget-up)
5. **Budget reallocation recommendations** → dry-run diff → approval (never auto-execute budget changes)
6. **Weekly report auto-generation** (exportable PDF/deck)
7. **Campaign launch checklist** — tracking, naming, budget, policy, UTMs, learning phase status all verified
8. **Policy rejection workflow** — detect rejection → request manual review/appeal first → only draft alternative if appeal fails (avoid circumvention risk)
9. **Conversion tracking health** — verify Pixel/CAPI fires, event_id dedup, browser/server parity, attribution window awareness
10. **Variant generation from winning angles** — human edits before push to platform

### Hard Constraints (non-negotiable)

- **Learning phase lock**: No AI-initiated changes to ad sets during learning phase. Display countdown and explain why.
- **Advantage+ awareness**: When Meta uses DCO, feed assets rather than manually structuring micro-variants.
- **Ground-truth validation**: Compare platform-reported conversions with backend data (Stripe/Shopify/CRM) before acting on CPA/ROAS signals.
- **Appeal before redraft**: Policy rejections trigger "request manual review" first, not immediate creative replacement.
- **Platform-native structure**: Never normalize away platform-specific concepts that affect algorithmic delivery.

### Cold Start Problem

Day 1 with zero historical data: AI operates in "observe + recommend" mode only. Import existing campaigns first if they exist. For new campaigns: broad targeting, multiple angles, small budget, explicit "explore" phase before switching to "exploit" (focus on winners). The transition must be explicit and human-approved.

### Model Strategy

Not every task needs a frontier model:
- **Frontier (Claude Opus/GPT-5.5)** — Diagnosis, causal analysis, complex recommendations
- **Mid-tier (Sonnet/GPT-4.1)** — Creative generation, report writing, variant remixing
- **Cheap/fast (Haiku/GPT-4.1-mini)** — UTM validation, policy checks, anomaly detection, data formatting
- **Deterministic code** — Budget math, pacing calculations, metric aggregation, threshold checks

### Failure Modes to Design Against

- Overfitting low-volume data (recommending changes based on <100 impressions)
- False fatigue detection (frequency ≠ fatigue without conversion data)
- Attribution delay (Meta reports conversions up to 7 days late — acting on "0 conversions" day 1 is premature)
- Learning phase resets (any significant edit resets Meta's optimization)
- Policy false negatives (AI says "compliant" but Meta rejects)
- Budget pacing during API outage (kill switch needed)
- Duplicate CAPI events (event_id dedup is mandatory)
- Hallucinated causality ("CPA up because..." must show data, not guess)
- Stale metrics (acting on data that's hours old when platform state has changed)

### Evaluation

How to know if AI is helping:
- Compare AI-managed campaigns vs. manual baselines (CPA, ROAS, time-to-optimize)
- Track recommendation acceptance rate (if users always reject, AI is wrong)
- Measure time from problem detection → resolution
- Creative win rate (AI-generated vs. human-written)

---

## MVP — Campaign Pipeline First

Build one repeatable ad-campaign pipeline first, then layer platform-specific fields and tools over it. Do not build separate products for Instagram, Google, TikTok, Reddit, etc.

Recommended first vertical: **Instagram/Meta draft campaigns**. It exercises the full loop (brief → audience → creative → paused draft → approval → reporting) while keeping spend and publishing behind explicit approval.

Fallback first vertical: **Google Ads tracking**. This is technically simpler and trust-building because the official Google Ads MCP path is read-only, but it does not prove the full campaign creation workflow.

Connector strategy: use MCP servers and direct APIs behind a `ChannelConnector` adapter. The product is the intelligence and workflow layer, not the platform API wrapper.

### Repeatable Campaign Template

Every channel should share the same core pages:

1. **Campaign Brief** — goal, product, offer, landing page, audience, budget.
2. **Strategy** — angle, funnel stage, placements/channels, success metrics.
3. **Offer & Positioning** — value prop, proof points, objections, CTA.
4. **Audience** — targeting, exclusions, suppressions, retargeting, lookalikes.
5. **Creative Variants** — hooks, copy, formats, assets, lineage.
6. **Channel Draft** — platform-native structure, draft objects, paused status.
7. **Tracking QA** — UTMs, pixels/events, conversion mapping, landing-page checks.
8. **Approval Queue** — human review for launch, spend, budget changes, policy risk.
9. **Performance** — spend, CTR, CPC, CPA, conversions, freshness, status.
10. **Recommendations** — kill, scale, duplicate, rewrite, test new creative.

Platform overlays add fields/tools without changing the base journey:

- **Instagram/Meta** — placements, ad sets, creatives, learning phase, Advantage+, ad review status, CAPI/Pixel checks.
- **Google Ads** — campaigns/ad groups, keywords, match types, negative keywords, search terms, Quality Score, read-only reporting first.
- **TikTok** — hooks, creator-style scripts, Spark Ads, video variants, creator briefs.
- **Reddit** — communities, post/comment style, interest targeting, context/intent fit.

### The Wedge

Open, local-first, explainable ad operations for technical growth teams and agencies who want:
- Transparent AI recommendations with evidence (not black-box optimization)
- Self-hosting and data ownership
- Custom rules and auditability
- No SaaS lock-in

The product is: **an AI operator that detects waste, explains WHY, proposes specific fixes, and executes after approval — across platforms.**

### MVP Build Sequence (Trust-First)

Build trust before touching money. Sequenced so each phase proves value and earns the right to the next.

**Phase 0 — Local Workflow Scaffold**
- [ ] Campaign pipeline pages with AG-UI page context.
- [ ] SQLite persistence for campaign briefs, form drafts, approvals, and audit log.
- [ ] Page-local tools for summarizing pages, filling fields, validation, save draft, and next-step navigation.
- [ ] Searchable SQLite tool registry for global tools.
- [ ] No external ad-platform writes.

**Phase 1 — Connect & Onboard**
- [ ] Connector configuration behind `ChannelConnector`.
- [ ] OAuth or MCP auth flow for ad platform auth.
- [ ] Import existing campaigns/ad sets/ads where the connector supports it.
- [ ] Token management, permission verification, account health check.
- [ ] "Why can't I access this?" diagnostic for common auth issues.

**Phase 2 — Read-Only Intelligence**
- [ ] Pull metrics via MCP (async insights polling, rate-limit aware)
- [ ] Performance dashboard (key metrics per ad/ad set/campaign, cross-platform)
- [ ] Anomaly detection (spend pacing deviations, fatigue signals, CPA spikes)
- [ ] Tracking health verification (Pixel + CAPI event_id dedup, UTM validation)
- [ ] Weekly report generation (exportable PDF/deck)
- [ ] AI explains: "what's happening, why, and what I'd recommend" — no execution

**Phase 3 — Safe Write Operations**
- [ ] Recommendation pipeline (propose with evidence + confidence score + dry-run diff)
- [ ] Approval/audit trail (every action logged, reversible, with before/after state)
- [ ] Constrained actions only: pause, resume, budget-down (NEVER budget-up without explicit human action)
- [ ] Learning phase awareness (hard block on changes during Meta learning phase)
- [ ] Platform state machine respect (no changes that reset algorithmic optimization)
- [ ] Idempotency keys + action locks for money-moving operations
- [ ] Rollback capability for every executed action

**Phase 4 — Creative & Launch**
- [ ] Copy variant generation (hooks × bodies × CTAs via LLM)
- [ ] Image generation deferred — copy + image prompts only for MVP
- [ ] Policy pre-screening (Meta advertising policies, Google Ads policies)
- [ ] Human editing of AI drafts before push (table-stakes UX)
- [ ] Campaign launch checklist (tracking, naming, budget, policy, UTMs verified)
- [ ] Limited campaign/ad creation from templates (new campaigns start paused)
- [ ] Variant registry (track lineage: which prompt/model/brief produced what)

### AI Architecture (Single Pipeline, Not Engines)

One recommendation pipeline with capabilities — NOT 5 separate "engines":

```
Observe → Analyze → Draft → Screen → Recommend → (Approval) → Execute → Measure
```

Capabilities within the pipeline:
- **Generate**: Structured variant generation, copy remixing
- **Analyze**: Fatigue detection, funnel diagnosis, causal analysis
- **Screen**: Policy compliance check before any write
- **Decide**: Propose state changes with evidence and confidence
- **Remember**: Brand voice, past winners/losers, creative lineage (basic RAG)

### Authority Model (5-Tier Risk)

| Tier | AI can... | Example |
|------|-----------|---------|
| **Observe** | Pull metrics, summarize, report | Dashboard refresh, anomaly detection |
| **Draft** | Generate copy, replacements, reports | Variant generation, weekly report |
| **Recommend** | Propose action with evidence + dry-run diff | "Pause this ad set — here's why and what happens" |
| **Execute constrained** | Pre-approved reversible actions under explicit limits | Pause/resume, budget-down within cap |
| **Blocked** | Cannot do without explicit human action | Launch, budget increase, delete, special-category targeting |

Every action in tiers 3-4 requires: dry-run diff preview, confidence score, evidence chain, audit log entry, and rollback path.

### Hard Constraints

- **Learning phase lock**: No AI-initiated changes to Meta ad sets during learning phase (first 50 conversions / 7 days)
- **Advantage+ awareness**: Feed assets to Meta's DCO rather than manual micro-variant structuring
- **Policy rejection workflow**: First action on rejection = request manual review/appeal, NOT immediate redraft (circumvention risk = account ban)
- **Ground-truth conversions**: Recommendations must be validated against backend data (Stripe/Shopify/CRM) not just platform-reported conversions
- **Platform-native structure**: Campaign architecture must respect platform-specific concepts (Meta: ODAX objectives, Advantage+; Google: keywords, match types, Quality Score) — no premature normalization

### Model Strategy

- **Frontier (Claude Opus/GPT-5.5)** — Diagnosis, complex recommendations, causal analysis
- **Mid-tier (Sonnet/GPT-4.1)** — Creative generation, reports, variant remixing
- **Cheap/fast (Haiku/GPT-4.1-mini)** — Policy checks, anomaly detection, UTM validation
- **Deterministic code** — Budget math, pacing calculations, metric aggregation, threshold checks

### MVP Skip (v2+)

- Image generation (policy/copyright/brand risk — copy + prompts first)
- Email, SMS, lifecycle marketing
- Lead scoring, lifecycle stages
- Multi-step campaign workflows
- Complex attribution modeling
- Landing page builder
- CRM sync
- Multi-tenant / teams
- Predictive forecasting
- Budget-up automation (always human-initiated)

---

## Phase 1 — Contracts & Core Domain

- [ ] `/spec` — Domain contracts in `packages/contracts/` (Zod schemas)
  - Canonical marketing object model: campaign → channel campaign → ad set/ad group → ad → creative → asset
  - Platform-specific extensions (Meta: ODAX objectives, Advantage+, ad review status; Google: keywords, match types, Quality Score, search terms)
  - Audiences (segments, suppressions, exclusions, lookalikes — platform-native, not over-normalized)
  - Metrics (conversion events, attribution windows, metric snapshots, data freshness, platform-reported vs. ground-truth)
  - Recommendations (detection → evidence → confidence → proposed action → dry-run diff → approval → execution → measured outcome)
  - Approvals (multi-step, role-based, audit log, rollback, before/after state)
  - Connectors (MCP server config: URL, auth, platform, provider — swap without code change)
  - Creative (variants, lineage tracking, prompt/model/brief provenance)
  - Scheduling (budget pacing, timezone rules, learning phase windows)
  - Skills & Agents (plugin manifests — already partially done in open-design)
  - Adapter interfaces: only for volatile external boundaries (ChannelConnector, LLMProvider, JobRunner, ReportRenderer, AuthProvider, MetricsStore)

## Phase 2 — Core Services (MVP-scoped)

- [ ] `/spec` — MCP connector runtime (connect to any MCP server URL, tool discovery, rate-limit queue, retry with backoff, idempotency)
- [ ] `/spec` — Metrics ingestion service (pull from MCP connectors, normalize to common schema, store snapshots, freshness tracking)
- [ ] `/spec` — Recommendation pipeline (observe → analyze → screen → recommend, with confidence scoring and evidence chain)
- [ ] `/spec` — Approval/audit service (action queue, dry-run diffs, before/after state, rollback, permission scoping)
- [ ] `/spec` — Reporting service (dashboards, spend tracking, ROI, weekly rollups, PDF/deck export)
- [ ] `/spec` — Creative service (variant registry, prompt templates, copy generation, policy pre-screen, lineage)
- [ ] `/spec` — Campaign launcher (checklist verification, create-paused, tracking validation, UTM governance)

## Phase 3 — Intelligence & Scale

- [ ] Additional MCP connectors (LinkedIn via Adspirer, TikTok/Snap/Reddit via Pipeboard)
- [ ] Cross-platform unified dashboard and recommendations
- [ ] Chat-to-analytics ("why did CPA spike in California yesterday?" → chart + hypothesis)
- [ ] Autonomous monitoring (background daemon, cron-based metric pulls, alert on anomalies)
- [ ] Image generation integration (with human-edit-before-push workflow)
- [ ] Forecasting engine ("if budget +$2k → predicted +45 leads at $110 CPA")
- [ ] Ground-truth conversion integration (Shopify/Stripe webhooks, CRM events)

## Phase 4 — Platform & Polish

- [ ] Email/SMS channel (lifecycle marketing, cold outreach — Odoo reference)
- [ ] Campaign workflow engine (multi-step, event-triggered, branching — Mautic reference)
- [ ] CRM sync connectors (HubSpot, Salesforce, Pipedrive)
- [ ] Landing page builder
- [ ] Collaboration/approval workflows (multi-role, multi-step)
- [ ] User-extensible skills + agents (marketplace / sideload)
- [ ] Multi-tenant / teams / RBAC
- [ ] Agentic UI (A2A, MCP-UI, Web-MCP)
- [ ] Electron desktop app

---

## Domain References (what to learn from each codebase)

### Mautic (indexed, `integrations/mautic/`)

Graph: `Users-la-Desktop-Programming-Open-Marketing-integrations-mautic` (48,581 nodes, 202,294 edges)

Relevant for:
- Campaign engine (event-based workflow tree, branching, timing)
- Contact entity model (custom fields, segments, lead scoring, lifecycle stages)
- Email sending infrastructure (bounce handling, monitored mailboxes, transactional vs. marketing)
- CRM integration patterns (field mapping, sync direction, conflict resolution — 8 CRM integrations)
- Form builder → action pipelines
- Plugin/integration architecture (AbstractIntegration → 12 concrete integrations)

### Odoo Community 19 (copied, `integrations/odoo-marketing/`)

Relevant for v2+ (email, SMS, CRM):

| Module | What it teaches | Use when |
|--------|----------------|----------|
| `mass_mailing` | Email campaign state machine (outgoing → sent → opened → clicked → replied / bounced / error), mailing traces, blacklist/opt-out handling, scheduled sends, A/B testing (subject lines), inline template builder | Adding email channel |
| `mass_mailing_sms` | SMS campaign model, phone validation, SMS-specific failure types (credit, format, country), Twilio integration pattern | Adding SMS channel |
| `utm` | UTM tracking model (campaign, medium, source, tag, stage), UTM mixin for any trackable object | Implementing UTM governance |
| `link_tracker` | Click tracking, shortened URLs, click attribution back to mailing traces | Implementing measurement/attribution |
| `sms` | SMS provider abstraction, send/receive, delivery notifications, IAP integration | SMS service spec |
| `crm` | Lead/opportunity model, pipeline stages, lead scoring, sales team assignment, lead-to-opportunity conversion | Building contact management + sales handoff |
| `social_media` | Social account linking, sharing widgets (minimal — icons only, no publishing) | Not very useful |
| `marketing_card` | Digital business card generation (niche feature) | Probably skip |
| `mass_mailing_crm` | Mailing list → CRM lead conversion, campaign attribution to pipeline | Connecting email campaigns to revenue |

### Odoo Enterprise (not downloaded — proprietary)

Enterprise-only modules we'd need to reverse-spec from docs/screenshots:

| Module | What it teaches | Notes |
|--------|----------------|-------|
| `marketing_automation` | Multi-step workflow builder with conditions, timers, child activities, server actions | The campaign engine we need — community doesn't have this |
| `social` (enterprise) | Full social publishing (Facebook, Twitter, LinkedIn, Instagram), scheduling, engagement monitoring | Community only has link-sharing icons |
| `social_facebook` / `social_instagram` / etc. | Platform-specific API connectors for social publishing | Reference for our MCP social connectors |
| `marketing_automation_sms` | SMS steps in automation workflows | Multi-channel orchestration patterns |
| `website_sale_dashboard` | E-commerce marketing dashboards | Dashboard/reporting UX patterns |

Key insight: Odoo's **community** edition is email-only. The real campaign orchestration engine (`marketing_automation`) is enterprise-only. We'll need to design ours from Mautic's campaign builder patterns + Odoo enterprise docs rather than community code.
