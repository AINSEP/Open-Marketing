# Mautic Architecture — Reference Analysis

> Reference-only analysis of upstream Mautic, done to decide **what to port** into the
> Open Design–based Open Marketing repo. Mautic is reference material, not a source to
> copy wholesale (see `todo.md`).
>
> - **Source:** `../Open-Marketing-old/integrations/mautic` (full clone of
>   `github.com/mautic/mautic.git`, analyzed at commit `edf30b4d`)
> - **Tools:** codebase-memory-mcp (LSP index, complexity/loop metrics) + graphify
>   (`graphify-out/`, Tree-sitter graph, betweenness/cycles). Two independent engines
>   used as a cross-check.
> - **Date:** 2026-06-30

## TL;DR

- **Rating: 6/10.** Solid modular macro-architecture (clean bundle boundaries, event-driven
  decoupling, real test coverage, **module-level import graph is fully acyclic**) dragged
  down by concentrated micro-rot (a handful of god-objects and fat controllers/subscribers).
- **The rot is concentrated, not diffuse** — a few named files hold most of the pain. Good
  news for porting: you can quarantine and rewrite them rather than untangle the whole graph.
- **Port strategy:** lift the *domain concepts and event-driven shape*, rewrite the *Model
  layer*. Port logic closely in exactly one place — the `LeadBundle` segment `QueryBuilder`
  (battle-tested SQL generation). Leave the god-objects behind.

## What it is

Upstream Mautic is a ~15-year-old **Symfony/PHP** marketing-automation platform.
~4,300 PHP files. Classic **Symfony bundle architecture**: every feature is a self-contained
"Bundle." Two tiers:

- `app/bundles/*` — **29 core bundles** (the product)
- `plugins/*` — **12 plugins** (integrations + the email builder)
- `themes/*` — ~25 email/landing-page themes (mostly CSS/config, low porting value)

Plugins depend on core, not the reverse (e.g. `MauticCrmBundle → bundles` = 519 calls).

### The 29 core bundles (by port value)

**Marketing-automation heart (highest value):**
- `LeadBundle` — contacts, segments, custom fields. Biggest, highest fan-in bundle. Its
  `Segment/Query/QueryBuilder` is the segment-filtering engine (cbm fan-in 569).
- `CampaignBundle` — visual campaign flows, `Executioner` (step scheduling), `Membership`.
- `EmailBundle` — sending, `MonitoredEmail` (bounce/reply), tokens/hit tracking.
- `PointBundle` / `StageBundle` — lead scoring and lifecycle stages (small, self-contained).
- `FormBundle`, `PageBundle` — landing pages & forms with tracking.
- `DynamicContentBundle` — personalized content blocks.
- `ChannelBundle` — abstraction over email/SMS/notification channels.

**Supporting channels:** `SmsBundle`, `NotificationBundle`, `AssetBundle`, `DashboardBundle`,
`ReportBundle`, `StatsBundle`.

**Platform/infra (mostly Symfony plumbing — low port value):** `CoreBundle`, `ApiBundle`,
`UserBundle`, `ConfigBundle`, `CategoryBundle`, `WebhookBundle`, `IntegrationsBundle` (modern
sync framework), `PluginBundle` (legacy integration base), `MessengerBundle`/`QueueBundle`,
`CacheBundle`, `InstallBundle`, `MarketplaceBundle`, `ProjectBundle`.

### The 12 plugins

- **Email builder:** `GrapesJsBuilderBundle` — drag-and-drop email/MJML editor (largest JS
  surface: `grapesjs-ckeditor`, `grapesjs-mjmlThemeTokens`).
- **CRM/sync/enrichment:** `MauticCrmBundle` (Salesforce/HubSpot/Pipedrive/etc.),
  `MauticSocialBundle`, `MauticEmailMarketingBundle`, `MauticFullContactBundle`,
  `MauticClearbitBundle`, `MauticCloudStorageBundle`, `MauticGmailBundle`,
  `MauticOutlookBundle`, `MauticZapierBundle`, `MauticTagManagerBundle`, `MauticFocusBundle`.

## Bundle anatomy (the pattern repeats everywhere)

Every bundle is a standard Symfony slice. Example `CampaignBundle`:

```
Entity/            Doctrine ORM models (DB schema)
Model/             business-logic services (the meat)
Controller/        HTTP endpoints
Form/              Symfony form types
Event/ EventListener/ EventCollector/   the event bus (how bundles talk)
Executioner/ Membership/ Service/       feature-specific logic
Config/ DependencyInjection/            wiring, routes, service defs
Command/           CLI commands (cron)
Twig/ Migrations/ DataFixtures/ Tests/ Translations/
```

**Key porting insight: Mautic is event-driven.** Bundles don't call each other directly —
they dispatch/subscribe events (`EventListener/` + `Event/` everywhere). To port a feature,
port its **Model + Entity + the events it fires**.

## What's good (why it's not lower than 6)

- **Clean bundle modularity.** 29 core bundles + 12 plugins with mostly-unidirectional
  boundaries. Community clusters line up with the folder layout.
- **Module-level import graph is fully acyclic** (graphify: "Import Cycles: None detected").
  The scary raw "1,390 core→plugin calls" from cbm deflates to ~150 real calls once you strip
  mislinked translation-string constants (1,106 of them). Coupling is *contained*, around
  contact-creation and campaign-membership only.
- **Event-driven decoupling** — you can port `PointBundle` without dragging in `CampaignBundle`.
- **Real test coverage** — cbm counted 25,937 TESTS edges; functional + acceptance suites.
- **A modern refactor already in flight** — `IntegrationsBundle` (`Sync/`, cohesion 0.91) is a
  clean 2nd-gen replacement for legacy `PluginBundle`.

## What's broken (why it's not higher)

### 1. God-objects (concentrated pain)

| symbol | signal |
|---|---|
| `Lead` entity | **~2,050 lines, 158 methods** (`app/bundles/LeadBundle/Entity/Lead.php`) — fat but insular |
| `Stat` | 152 methods |
| `AjaxController` | 108 methods — junk-drawer controller |
| `LeadSubscriber` / `CampaignSubscriber` / `SearchSubscriber` | 95 / 94 / 85 methods — event bus decouples bundles, but each subscriber became its own monolith |

### 2. Fat controllers with hidden depth

`ProfileController.indexAction` (`app/bundles/UserBundle/Controller/ProfileController.php:24`):
**228 lines, 5 injected deps, 34 distinct downstream calls.** Its *own* loop depth is 1 but
its **transitive loop depth is 18** — it looks innocent locally but pulls a deeply-looping
data-assembly chain inline instead of behind a service. (This metric is **cbm-only**;
graphify's no-LLM mode has no complexity/loop metrics.)

### 3. Divergent copy-paste in CRM sync

`amendLeadDataBeforeMauticPopulate` — cognitive complexity 170, transitive loop depth 10,
appears **3× across CRM integrations** with divergence. Runs per-contact-sync (hot path).

### 4. Framework lock-in leaks into the domain

Symfony infra is threaded through business logic, not held at the edges:
- cbm hotspots: `CacheStorageHelper.get` (1,163 fan-in), `Translator.trans` (637).
- graphify betweenness bridges: `CoreParametersHelper` (0.067) and `Email` (0.032) thread
  through the whole system — the concrete "wrap behind an interface first" list for a port.

> Note: the single highest cognitive-complexity method (`ServicePass.process`, 227) is a
> Symfony **DI compiler pass** — ugly but cold infra (runs once at container compile), *lower*
> risk than the per-sync CRM methods above. Not every big number is equally dangerous.

## Two-tool cross-check (cbm-mcp vs graphify)

Same repo, two independent engines. cbm: 48.8k nodes / 202.9k edges. graphify: 30.7k nodes /
67.4k edges / 1,555 communities.

- **Agree:** `Translator`, the segment `QueryBuilder`, and Core config/cache helpers are the
  top hubs; a **test base class dominates degree** (`MauticMysqlTestCase` / `CommonRepository`
  — noise). Two engines agreeing = high confidence.
- **graphify added:** (1) **acyclic-at-module-level** (portability green light); (2) the
  **`Lead` vs `Email` lens flip** — `Lead` is fat-but-insular (huge inside), while `Email` is
  the connectivity **hub** bridging ~90 communities (referenced everywhere) and isn't even in
  cbm's method-count top-list; (3) **betweenness-ranked** "wrap-first" targets.
- **cbm added:** complexity / cognitive / `transitive_loop_depth` (hot-path depth — e.g. the
  `indexAction` loop-18 finding). graphify's no-LLM mode can't see this.
- **graphify weaker on:** community cohesion here is noisy (910 thin communities, 694 isolated
  `composer.json`-key nodes, big-community cohesion ~0.006 vs cbm Leiden 0.7–0.93).

**Use both:** cbm for hot-path/complexity depth, graphify for connectivity/cycles + a portable
report artifact.

## Recommended improvements (if this were the codebase to fix)

1. **Extract read-model/query services out of fat controllers & subscribers** — highest ROI,
   lowest risk (controllers are the worst offenders and least depended-upon).
2. **Split the god-entities** — `Lead`'s 158 methods are ~5 concerns (identity, scoring,
   activity, custom fields, serialization) → slim entity + focused services.
3. **Finish `PluginBundle` → `IntegrationsBundle` migration and delete the legacy path;**
   collapse the 3 divergent `amendLeadDataBeforeMauticPopulate` copies into one shared
   sync-mapping service.
4. **Push Symfony behind interfaces** — wrap `CoreParametersHelper` / `CacheStorageHelper` /
   `Translator` / `Email` so 300–1,100 call sites aren't hard-bound to framework internals.
   This is also what makes the code *portable* to the Open Marketing stack.

## Port targets for Open Marketing (ranked)

1. **`LeadBundle` segment engine** — the `QueryBuilder`/filter model is the reusable crown
   jewel; port the *logic* closely.
2. **`CampaignBundle` Executioner** — campaign step-scheduling logic.
3. **`EmailBundle`** tokens + send/tracking model (treat `Email` as a system-wide contract).
4. **`PointBundle`/`StageBundle`** scoring — small and self-contained.
5. **`MauticCrmBundle`** sync patterns if/when CRM integrations are needed.

**Skip** (Symfony-specific, rebuild native to Next/Electron): `CoreBundle`, `InstallBundle`,
`MessengerBundle`, `MarketplaceBundle`, themes.

## Reproducing / refreshing this analysis

- **graphify** (installed CLI, `$0` no-LLM): `cd ../Open-Marketing-old/integrations/mautic &&
  graphify update .` → refreshes `graphify-out/{graph.json, GRAPH_REPORT.md}`. Query offline
  with `graphify query "..."`, `explain "X"`, `path "A" "B"`, `affected "X"`. Optional LLM
  `graphify label .` names the communities (currently unlabeled placeholders).
- **codebase-memory-mcp:** project `Users-la-Desktop-Programming-Open-Marketing-old-integrations-mautic`
  (re-indexed 2026-06-30 at the `-old` path; the stale `...Open-Marketing-integrations-mautic`
  project was deleted). Use `get_architecture`, `query_graph`, `search_graph`, `get_code_snippet`.
