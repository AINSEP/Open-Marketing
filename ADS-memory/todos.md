# Open Marketing — todos

Updated 2026-10-24 by open-marketing-6b. Newest priorities first.

## HIGH PRIORITY — next Codex credits: roadmap Phases 0–4
The full plan is in `ADS-memory/reports/2026-10-24-om-roadmap-phases.md`. The debate merged it to 5 phases, P0–P4.

- [ ] **Owner decision first:** do vendor metrics go in a new `performance` slice or in `measure`? The debate split 2–2.
- [ ] **P0 Contracts.** Freeze these before the new plugins are wired:
  - approver/actor contract;
  - `report.metrics.v1` (per-campaign, per-day);
  - capability IDs;
  - NeutralCampaignLaunch v2;
  - consent/erasure dispatch barrier;
  - upstream Jini request for an instance-injected permission catalog.
- [ ] **Pre-P1 check:** 1–2 days read-only on one real Google account and one real Meta account. Spend must match the vendor dashboards within ~1%, and a test lead must be credited to the right campaign.
- [ ] **P1 "Know if my ads work":**
  - tracking snippet and tags, UTM policy;
  - destination check;
  - form lead → lead inbox;
  - per-campaign results;
  - 3 alerts;
  - Jini owner identity on approvals.
- [ ] **P2 "Launch better and close the loop":**
  - offline conversions;
  - leads/sales objectives and local targeting;
  - pre-flight checks;
  - brand kit and catalog;
  - all 16 ad plugins on report.metrics.v1.
- [ ] **P3 "Optimise and scale":**
  - optimisation proposals;
  - A/B tests;
  - Tovu landing-page handoff;
  - CRM sync;
  - weekly report;
  - teams/agency via Jini user-management.
- [ ] **P4 "Grow beyond paid":**
  - audiences;
  - messaging journeys (Resend/Twilio/WhatsApp/SES);
  - organic social and Google Business Profile;
  - multi-touch attribution, only if the data warrants it.

## HIGH PRIORITY — swap OM infrastructure to Jini (owner, 2026-10-24: "it should use Jini's stuff")
- [ ] **Codex plan first, then a staged swap.** Replace OM-built infrastructure with Jini 0.6.x wherever Jini covers it:
  - **Outbox:** `@jini-ai/infra/events/outbox` (0.5.4, retained owner) in place of OM's `features/jobs` outbox. Keep these invariants: ONE outbox, atomic intent+enqueue, idempotency keys, unknown outcomes never blindly retried.
  - **Outbound webhooks:** `@jini-ai/integrations/webhooks` (subscriptions, delivery worker, signing, keyring).
  - **Scheduling + event log:** `@jini-ai/daemon` scheduler and the sqlite event-log.
  - **Email:** `@jini-ai/platform/mail` (engine, policy, feedback/suppression, sender verification), plus `@jini-ai/platform` aws-sigv4 for SES.
  - **Gap check:** grep OM for any other self-built infra Jini already ships (http guarded fetch, secrets, rate limits, retries) and list it.
  - **Missing from Jini:** propose it as an upstream Jini addition, never an OM-local copy.

## QUEUED — Tovu → Jini extraction audit (owner, 2026-10-24)
OM is now Jini's second consumer, so rule-of-two applies. Find Tovu code that is abstract enough to live in Jini and be reused by OM; don't copy it into OM.
- [ ] Codex inventory (read-only) of Tovu ↔ OM overlaps. Rank each by reuse value and by how cleanly it separates from Tovu. Candidates seen so far:
  - credential/connection cards (Tovu credential-cards.ts, connect-card-ui.ts);
  - site guide + capability cards;
  - chat-pane wiring/hooks (Tovu App.tsx/panels.tsx);
  - admin theme registry + accent swatches;
  - sidebar empty-click/rail hooks;
  - plugin admin-surfaces/exports host;
  - mail adapters (tovu-mail-adapters.json);
  - test-rigor/coverage scripts;
  - per-route tool-coverage parity checks.
- [ ] **Coordinate with the Tovu/Jini owner session (tovu-ed):** Jini changes land in Jini and publish to npm, and OM only consumes published versions.
- [ ] **Known Jini asks already queued:**
  - instance-injected permission catalog (user-management);
  - vendor/effort pickers + authoritative cost in chat;
  - an effort option in agent-runtime;
  - a messaging (SMS) engine.

## QUEUED — OM's own design system theme: sleek black and white (owner, 2026-10-24)
- [ ] A NEW theme that does not copy Tovu's look. Sleek black and white: black-on-white in light mode, white-on-black in dark mode. Give it its own design-system values:
  - font pair (display + text; installed or OFL webfonts);
  - neutral palette + a single restrained accent (or none);
  - radius, border, shadow and spacing scale;
  - nav and metric treatments.
- [ ] This also proves the theming system works: the new theme must need ZERO component edits (tokens only). If it can't be expressed, fix the token contract, not the components.
- [ ] Decide whether it becomes OM's default theme (likely yes). Before the owner sees it, run a Claude-in-Chrome visual pass that adjusts values only.
- [ ] Related: the existing Mono theme (TH1) is close in spirit, but it is a palette-only variant; this one is a full design system.

## QUEUED — marketing skills as agent plugins (owner-approved shape, 2026-10-24)
Sources: `codex-runs/2026-10-24-marketing-skills/research.md`. Only MIT/Apache sources; each plugin gets a PROVENANCE.md (repo, commit, license, changes). Strip tool/host assumptions and any instruction that escalates tools.
- [ ] **1. General marketing → `om-playbook`.** Adapt from Corey Haines, Anthropic and Aaron:
  - strategy and briefs;
  - copywriting;
  - landing-page CRO;
  - analytics/attribution;
  - ad creative testing.
- [ ] **2. Platform-specific skills → each vendor's agent plugin:**
  - Google's official Ads skills → google-ads;
  - Meta, LinkedIn, TikTok, Amazon, Pinterest, Reddit, Microsoft skills (Claude Ads, Hyper, Rebecca Rae) → their plugins;
  - Higgsfield's official skills → higgsfield-media.
- [ ] **3. Optional topic add-ons as their own agent plugins:** `seo` (Claude SEO), `email-lifecycle` (email-marketing skill + CRM wiki), maybe `social-publishing` (Publora).
- [ ] **Already in the right format:** Aaron Marketing Skills ships an Agent Plugins 1.0.0 "Portable Lite" build, and Anthropic's marketing plugin is already a plugin. Convert the rest to agent plugins.
- [ ] **Skill router:** one small way for the assistant to pick the right skill or plugin per task. Check Jini agentic's skill discovery first; Tovu's site_guide pointer pattern is the model. Don't build a framework if Jini covers it.

## QUEUED — more chart plugins (owner: "visualization is really important")
- [ ] Charts are downloadable chart PLUGINS through Jini's chart contract, never npm deps in OM (owner decisions 4 and 10). Today only the Recharts plugin exists (`content/plugins/charts-recharts`).
- [ ] **Owner pick (2026-10-24): Apache ECharts and Chart.js.** Build these two first.
- [ ] Maybe later, experimental, owner undecided: OpenUI (https://github.com/thesysdev/openui), generative UI. Evaluate before adopting.
- [ ] Other candidates considered (check licenses):
  - Apache ECharts — Apache-2.0, very rich;
  - Nivo — MIT;
  - Chart.js — MIT;
  - Vega-Lite — BSD-3, declarative, good for the assistant to generate;
  - maybe Plotly — MIT.

  Pick 2–3 that cover dashboards (time series, funnels, maps, heatmaps) and the Phase 1 results view.
- [ ] Charts the assistant can render in chat (A2UI) and on the results dashboard.

## Finish the stopped plugin pipelines (automation stopped 2026-10-24 23:xx)
Check each `codex-runs/2026-10-24-plugin-<p>/` folder's R1/R2 status, review and fix files, then commit what is reviewed and typechecks. The scripts `autocr-plugins*.sh` and `autofix-plugins*.sh` can be restarted to finish the loop.
- [x] DONE (verified 2026-10-25): all 12 ad plugins have R1 (reads + auth) and R2 (paused launch + readback) reviewed and committed. Resend, Twilio, WhatsApp and SES have R1 reviewed and committed. Plugin compile status was per-plugin typecheck only, and nothing is wired into the server yet.

## In progress / next (carried from 2026-10-24)
- [ ] **Chat panel parity, remaining gaps.** After commit 2359518 (screenshot in scratchpad, chat-after.png), it is much closer: right dock, "New chat" title, Claude logo + "Opus 5.5", "Default" effort, readable approval summaries. Still missing:
  - header icon buttons (agents/history/settings/close);
  - "+" attach;
  - send arrow;
  - ▾ chevrons on the pickers;
  - flatter approval cards (no box-in-box);
  - a real-run status line.

  Next: a Claude-in-Chrome visual pass that adjusts CSS values only.
- [ ] **Chat panel parity with Tovu (owner's top UI item).** The owner's list is in `codex-runs/2026-10-24-jini-upgrade/owner-feedback-2254.md`, with screenshots alongside it. It covers:
  - right-side dock;
  - Jini header and history;
  - vendor, model and effort pickers with logo;
  - readable approval card;
  - context chips;
  - status line;
  - "+" image attach.

  It depends on the chat backend (CB1 R1 is under review; CB1 R2 adds image attachments).
- [ ] **Upstream Jini gaps.** Ask the Tovu/Jini owner to add these:
  - vendor and effort picker support plus authoritative cost in @jini-ai/chat;
  - an effort option in agent-runtime `runProviderToolTurn`;
  - an instance-injected permission catalog in user-management.
- [ ] **Commit in-flight work after verification.** All of these need a code review, and Codex left its final typecheck unverified on several:
  - vendor cards (VC1 R1 + fixes);
  - chat backend (CB1 R1 + fixes);
  - Higgsfield server completion (H1 R2 + fixes; byte import still deferred).
- [ ] **Vendor cards R2:** cards for the 12 new ad plugins and the 4 messaging plugins. The studio card component is a DS2 need.
- [ ] **New-plugin wiring pass:** connect all 12 ad plugins and resend-email, twilio-sms, whatsapp-business and amazon-ses to the server (agent-plugin-backends, build script, catalog). Do this AFTER P0 freezes report.metrics.v1.
- [ ] **Messaging plugins R2:** broadcasts, suppression and webhooks for Resend, SES, Twilio and WhatsApp.
  - **Email: REUSE Jini.** Make resend-email and amazon-ses adapter modules for `@jini-ai/platform/mail` 0.6.12, the way Tovu's resend plugin does (`tovu-mail-adapters.json`). It provides the provider registry, purpose-scoped mailer, delivery policy with one-click unsubscribe, rate limits, feedback ingest with suppression, and sender-domain verification. Also use `@jini-ai/platform` aws-sigv4 for SES and `@jini-ai/integrations/webhooks`.
  - **SMS/WhatsApp:** no Jini infrastructure, so they stay plugin-only. A Jini messaging engine is a possible upstream addition.
- [ ] **Official brand logos:** waiting on the owner's OK to use official kits under each vendor's brand guidelines. Then Codex places them in `<plugin>/io.github.ainsep.openmarketing/assets/` (manifest-declared, digested), with the guideline URL recorded per file.
- [ ] **Agent Plugins standard:** move every `$schema` to the published 1.0.0 (plugin + mcp), and update `features/plugins/src/portable.ts` so it accepts 1.0.0.
- [ ] **Lint/complexity sweep:** cognitive >10 and nesting >3 errors, plus 19 two-object-argument breaches (see `codex-runs/2026-10-24-complexity/CX1.md`).
- [ ] **Marketing skills:** adapt the top MIT/Apache sources into om-playbook and the vendor plugins (see `codex-runs/2026-10-24-marketing-skills/research.md`). Record license and provenance for each.
- [ ] **Brand logos:** every card uses neutral monograms. Real logos need each vendor's brand-terms acceptance; Google's official button kit is the clean route.
- [ ] **Test quality:** coverage and test-quality audit using Tovu's guidance (`codex-runs/2026-10-24-test-quality/tovu-test-guidance.md`): Stryker, tightened TDD audit prompt, count the tests that actually ran.
- [ ] **T1 full test pass** (owner-approved for the end), then fixes.
- [ ] **P2 .dmg build:** Node 24.2.0 tarball + fresh builds, after everything above.
