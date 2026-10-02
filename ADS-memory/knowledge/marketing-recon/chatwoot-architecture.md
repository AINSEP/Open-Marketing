# Chatwoot Architecture — Reference Analysis

> Reference-only analysis of upstream Chatwoot, done to decide **what to port** into the
> Open Design–based Open Marketing repo. Chatwoot is reference material, not a source to
> copy wholesale.
>
> - **Source:** `/Users/la/Programming/OSS-Marketing-Repos/chatwoot` (clone of
>   `github.com/chatwoot/chatwoot`, analyzed at commit `926a9d8a`, 2026-06-30)
> - **Tools:** codebase-memory-mcp (project `chatwoot`, moderate mode) + graphify
>   (`graphify-out/`, Tree-sitter, no LLM) + `rg`. Two independent engines as a cross-check.
> - **Date:** 2026-09-06

## TL;DR

- **Two ratings, because they diverge sharply.**
  **Code quality: 8/10** — genuinely clean. No god-objects (largest class is 40 methods),
  max cognitive complexity 35 across ~14.4k Ruby functions, tidy service-object layering.
  **Marketing port value: 4/10** — Chatwoot is a *support inbox*, not a marketing-automation
  platform. Its "Campaign" is one message to one inbox. There is no journey builder, no
  sequence engine, no segment query language, no send-time optimization.
- **The single biggest constraint is licensing, not code.** `enterprise/` (320 `.rb` files,
  16,783 LOC — ~28% of the non-spec Ruby) is under a proprietary Chatwoot Enterprise License,
  and it holds **everything AI-native**: Captain (assistant, copilot, RAG documents, tool
  registry, scenarios), SLA, voice, companies, billing. **None of that is portable.** The MIT
  part is the inbox, the channels, and the thin campaign layer.
- **Port strategy:** lift the *channel abstraction* and the *Liquid drop* templating layer —
  those are the crown jewels and they are MIT. Take the automation-rule condition/action
  registry as a **shape**, not as an engine. Build the journey/sequence engine ourselves;
  Chatwoot has nothing to copy there. For segment logic, Mautic's `LeadBundle` QueryBuilder
  remains the better donor.

## What it is

Upstream Chatwoot is a **Rails 7.1 / Ruby 3.4** monolith with a **Vue 3 SPA** dashboard,
Postgres + Redis + Sidekiq. 8,344 tracked files: 2,230 Ruby, 1,089 Vue, 1,011 JS.
cbm indexed 35,516 nodes / 83,889 edges; graphify 25,265 nodes / 32,326 edges.

Layout is stock Rails, not a bundle/plugin architecture like Mautic — there is **no plugin
system**. Extension happens through three seams only: `app/models/channel/*` (new channel),
`app/services/automation_rules/` (new condition/action), and `app/models/integrations/`
(third-party hooks).

### The two-tier license split (read this before porting anything)

| Tier | Path | Files (`.rb`) | License | Portable? |
|---|---|---|---|---|
| Core | `app/`, `lib/` | 735 + 76 | **MIT Expat** | Yes |
| Enterprise | `enterprise/` | 320 (16,783 LOC) | **Chatwoot Enterprise License** — production use requires a paid seat-based subscription; modifications assign back to Chatwoot | **No** |

What sits behind the paywall, by directory:

- `enterprise/app/services/captain/` + `enterprise/app/models/captain/` — the whole AI layer:
  `assistant`, `assistant_response`, `custom_tool`, `document` (RAG), `scenario`,
  `message_report`, plus `copilot/`, `llm/`, `tools/`, `tool_registry_service.rb`,
  `reply_suggestion_service`, `summary_service`, `rewrite_service`, `label_suggestion_service`,
  `follow_up_service`.
- `enterprise/app/services/sla/`, `voice/`, `companies/`, `firecrawl/`, `cloudflare/`,
  `enterprise/billing/`.

**Implication:** the parts of Chatwoot that look most relevant to an agent-native Open
Marketing are exactly the parts you cannot take. Treat Captain as a *design reference read
under the development-and-testing carve-out*, and reimplement.

## Domain model (MIT tier)

```
Account ──┬── Inbox ── Channel::{WebWidget,Email,Whatsapp,Sms,TwilioSms,FacebookPage,
          │             Instagram,Telegram,Line,Tiktok,TwitterProfile,Api}   ← 12 channels
          ├── Contact ── ContactInbox ── Conversation ── Message
          ├── Campaign          (audience jsonb, trigger_rules jsonb)
          ├── AutomationRule    (conditions jsonb, actions jsonb)
          ├── Macro, Label, Team, CustomAttributeDefinition, CustomFilter
          ├── Portal ── Category ── Article       (help center)
          └── Webhook, ReportingEvent, ReportingEventsRollup
```

`Contact` carries `additional_attributes` + `custom_attributes` (both jsonb) and
`enum contact_type: { visitor, lead, customer }` — a usable, minimal CDP shape.

### Campaigns: shallower than the name suggests

`Campaign` is a **single message on a single inbox**, with two types:

- `ongoing` — Website inbox only. A live-chat proactive message fired by `trigger_rules`
  (URL match, business hours). Delivered by `Campaigns::CampaignConversationBuilder` (43 lines).
- `one_off` — Twilio SMS / SMS / WhatsApp only. Scheduled once, dispatched via
  `{Twilio,Sms,Whatsapp}::Oneoff*CampaignService`.

`audience` is a jsonb list of label ids. There is **no segment query language**, no
multi-step sequence, no branching, no A/B split, no per-recipient scheduling. Email is not
even a supported campaign inbox type. The model file carries its own admission:
`# TO-DO we clean up with better validations when campaigns evolve into more inboxes`.

### Automation rules: a good registry, a small engine

`AutomationRule` declares its surface as two literal arrays on the model — 18
`conditions_attributes` and 19 `actions_attributes` (20 with the one added in `enterprise/`) — evaluated by three services totalling
**342 lines** (`conditions_filter_service.rb` 210, `action_service.rb` 67,
`condition_validation_service.rb` 65). It is conversation-scoped and event-triggered
(`AutomationRuleListener`), not journey-scoped. The **declarative condition/action registry
is worth copying as a pattern**; the engine behind it is too thin to be worth porting.

### Liquid drops — the quiet crown jewel

`app/drops/` exposes `account`, `contact`, `conversation`, `inbox`, `message`, `user` to
Liquid, with `Liquid::CampaignTemplateService` rendering. This is a clean, small,
**MIT-licensed** templating boundary and maps directly onto what Open Marketing needs for
message personalization. Highest port-value-per-line in the repo.

## What's good

- **No god-objects.** Largest class is `Conversation` at 40 methods; `Message` 39, `Inbox` 34.
  Compare Mautic's `Lead` at 158. Nothing needs quarantining.
- **Complexity is flat.** Across ~14.4k Ruby functions the **maximum cognitive complexity is
  35** (`Twilio::TemplateSyncService.extract_body_content`); the top-20 tail is already down
  at 19. Mautic's worst was 227.
- **Uniform channel abstraction.** 12 channels behind one `Inbox`, each a model in
  `app/models/channel/` plus a service dir. Adding a channel is a well-worn path.
- **Event-driven listeners.** 12 listeners (`automation_rule`, `campaign`, `webhook`,
  `reporting_event`, `hook`, `notification`, …) off a `base_listener` — clean decoupling.
- **Both graph engines agree** the core abstractions are `Conversation` / `Message` / `Inbox`
  (graphify degree 41/40/35; cbm method counts 40/39/34). Two engines agreeing = high confidence.

## What's weak

### 1. Marketing depth is absent, not merely immature
No sequences, no segment engine, no email campaigns, no send-time logic, no deliverability
handling. `app/services/filters/` contains exactly one 55-line helper. There is nothing here
to port for the core of a marketing product.

### 2. Frontend cycles
graphify found **no Ruby import cycles**, but five 5-file cycles in the Vue router
(`dashboard.routes.js → settings.routes.js → teams.routes.js → *.vue → routes/index.js →`)
plus a self-cycle in `store/captain/tools.js`. Contained to the SPA routing layer; irrelevant
if we don't port the frontend (and we shouldn't — Open Marketing is Next/Electron).

### 3. CRM integration is one vendor deep
`app/services/crm/` has a `base_processor_service.rb` and exactly one implementation:
`leadsquared`. The abstraction exists but is unproven at N>1 — do not assume it generalizes.

### 4. The enterprise boundary is a license, not an architecture
Corrected on review: `enterprise/` is **not** a messy reopening of core classes. It is a
clean GitLab-derived `include_mod_with` / `prepend_mod_with` seam (21 core call sites, zero
overlapping file paths with `app/`). But the seam is not gated on a license at all —
`ChatwootApp.enterprise?` merely checks whether the `enterprise/` directory exists on disk
(`lib/chatwoot_app.rb:14-18`), and `enterprise/app/**` is **unconditionally eager-loaded**
(`config/application.rb:43-46`). Seven route families (`sla_policies`, `custom_roles`,
`agent_capacity_policies`, `companies`, `audit_logs`, `saml_settings`, `applied_slas`) are
drawn in `routes.rb` with no enterprise guard and work only because the folder is always
loaded. So "not portable" is a **licensing** statement, not an architectural one — lifting
from `app/` is mechanically clean; the constraint is legal.

## Two-tool cross-check (cbm-mcp vs graphify)

Same repo, two independent engines. cbm: 35.5k nodes / 83.9k edges, 12 Leiden clusters with
cohesion **0.66–0.83**. graphify: 25.3k nodes / 32.3k edges, **2,851 communities** of which
962 are singletons and cohesion runs ~0.01.

- **Agree:** `Conversation`, `Message`, `Inbox` are the core abstractions.
- **cbm added:** per-function `cognitive` complexity (the "max 35" finding), usable Leiden
  clusters, HTTP `Route` nodes (364), and `SIMILAR_TO` edges.
- **graphify added:** import-cycle detection (**Ruby: none**) and betweenness bridges —
  `ApiClient` 0.021, `current()` 0.018, `dependencies` 0.014. Note how *flat* that is versus
  Mautic's 0.067: Chatwoot has no single chokepoint to wrap first.
- **Both produced noise that would mislead a careless read** — see below.

### Tool calibration (carry these into the other 12 repos)

1. **cbm's loop metrics do not work on Ruby.** `loop_depth`, `transitive_loop_depth`, and
   `linear_scan_in_loop` are **0 for every one of the 14,378 Ruby functions**, while the same
   properties are populated on JS (`convertAudio` tld=5, `remuxWebmToOgg` tld=5). `cyclomatic`
   is likewise empty on Ruby; only `cognitive` is populated. The Mautic analysis leaned on
   `transitive_loop_depth` (the "loop-18 `indexAction`" finding) — **that lever is not
   available on a Ruby target**, and must be re-verified per language before it is used again.
2. **cbm `hotspots` fan-in is name-collision noise.** It reports
   `SuperAdmin::Devise::SessionsController.new` at fan_in **917** and
   `SlaPoliciesController.create` at 666 — these are every `.new` / `.create` call in the repo
   collapsed onto one arbitrary definition. Do not quote fan-in numbers from `get_architecture`
   without confirming the symbol is uniquely named.
3. **graphify's top-degree node is `vue` from `package.json` (733 edges).** Dependency-manifest
   keys dominate the degree ranking — the same failure mode as Mautic's 694 `composer.json`
   nodes. `package_dependencies` also appears at 81. Filter manifest nodes before ranking.
4. **graphify community detection is unusable here without the LLM labeling pass.** 2,851
   communities, 856 omitted as thin, 962 singletons, cohesion ~0.01. cbm's 12 Leiden clusters
   at 0.66–0.83 are the ones to read. (`graphify cluster-only --no-viz` + a labeling backend
   would improve this at LLM cost; not run.)
5. **graphify skipped `graph.html`** — 25,265 nodes exceeds its 5,000-node viz limit. Expect
   this on every repo in this set except possibly listmonk. Use `--no-viz` to save time.
6. **Cost/time:** cbm `moderate` index ≈ 1 min, 8,344 files → auto-excluded 48 dirs.
   graphify ≈ 2 min, 6,925 files, **$0 (no LLM)**. Both cheap enough to run on all 13.

**Use both:** cbm for complexity + clusters + routes, graphify for cycles + betweenness + a
portable committed report artifact.

## Port targets for Open Marketing (ranked)

1. **Liquid drops layer** (`app/drops/*`, `Liquid::CampaignTemplateService`) — small, MIT,
   directly reusable for message personalization. Port closely.
2. **Channel abstraction** (`app/models/channel/*` + per-channel service dirs) — port the
   *shape* (one Inbox, N channel adapters), reimplement the adapters we actually need.
3. **AutomationRule declarative registry** — the 18-condition / 19-action arrays as a
   contract. Port the pattern; write our own engine with journey semantics.
4. **Contact attribute model** — `custom_attributes` + `CustomAttributeDefinition` +
   `contact_type` enum. Cheap, sound CDP starting point.
5. **Listener/event bus** (`app/listeners/base_listener.rb` + 12 listeners) — the decoupling
   shape, not the code.
6. **`ReportingEvent` + `ReportingEventsRollup`** — pre-aggregated analytics rollup pattern.

**Skip:** all of `enterprise/` (license), the Vue SPA, `app/services/crm/leadsquared`
(single-vendor), the campaign services (too thin to be worth the read), help center / portal.

**Do not expect from this repo:** a segment engine, a journey builder, or an email-sending
pipeline. Source those from Mautic (segments), and from listmonk / dittofeed / novu when
those recons land.

## Reproducing / refreshing this analysis

- **graphify** (installed CLI, `$0` no-LLM):
  `cd /Users/la/Programming/OSS-Marketing-Repos/chatwoot && graphify update .`
  → refreshes `graphify-out/{graph.json, GRAPH_REPORT.md, manifest.json}`.
  Query offline with `graphify explain "X"` and `graphify path "A" "B"`.
  Add `--no-viz` to skip the (auto-skipped) HTML render.
- **codebase-memory-mcp:** project `chatwoot`, indexed 2026-09-06 in `moderate` mode at
  commit `926a9d8a`. Use `get_architecture`, `query_graph`, `search_graph`, `get_code_snippet`.
  Cypher note: numeric properties are stored as strings — wrap in `toInteger()` before
  `ORDER BY`, or the sort silently degrades to name order.
