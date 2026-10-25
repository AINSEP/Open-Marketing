# Open Marketing — todos

Updated 2026-10-25 by open-marketing-b5. Newest priorities first.

## HIGH PRIORITY — next Codex credits: roadmap Phases 0–4
The full plan is in `ADS-memory/reports/2026-10-24-om-roadmap-phases.md`. The debate merged it to 5 phases, P0–P4.

- [ ] **Architecture debate 2026-10-25** (Opus 5.5 / Codex 6.1 Sol / Gemini 4 Argon, 2 rounds): `ADS-memory/reports/2026-10-25-om-architecture-debate.md`.
  - **3–0:**
    - `leads` slice;
    - one capability catalog + invoker;
    - `CampaignKey`;
    - jobs due time;
    - consent subject lane;
    - metrics structure;
    - v2-only launches.
  - **2–1:** reporting in `measure`; a P2 `brand` slice; alerts as a server module.
  - **Owner questions:** listed at the end of the report.
- [ ] **Owner decision first:** do vendor metrics go in a new `performance` slice or in `measure`? The 10-24 debate split 2–2; on 10-25 it went 2–1 for `measure`.
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

## HIGH PRIORITY (later) — gap analysis vs open-source ad tools (owner, 2026-10-25)
Read their code and list what they do that OM doesn't. License rules: MIT/Apache can be adapted with provenance; AGPL (Postiz) is reference-only, never copy code. None are cloned yet; clone them into `/Users/la/Programming/OSS-Marketing-Repos` (recon docs stay there).
- [ ] Agentic Ads Studio (MIT): AI-generated ads, campaign management, Meta/Google/TikTok integrations.
- [ ] Adport (Apache 2.0): agentic ad management across 11 platforms over MCP and CLI.
- [ ] OpenAdKit (MIT): AI ad copy, campaign planning, creative optimisation.
- [ ] Postiz (AGPL 3.0): AI-assisted social posting, scheduling, analytics. Reference only.
- [ ] Open Marketing / OOSA (MIT): AI brand kits, marketing creatives, ad images. Name clash with OM to check.
- [x] DONE 2026-10-25: 5 Opus recons → combined list at `/Users/la/Programming/OSS-Marketing-Repos/docs/2026-10-25-ad-tools-gap-synthesis.md` (20 ranked gaps).
  - **Top for P0:**
    - Adport's metric definitions and reporting-semantics doc;
    - the per-vendor metric mapping;
    - the currency-safe summary.
  - **P2:**
    - vendor validate_only pre-flight;
    - brand kit (3 of 5 converge);
    - ad copy skill.
  - **P3:** rule packs → approval cards; fatigue computed in code.
  - **P4:** Google Business Profile; the organic publish contract.
- [x] **Blind Codex check (10-25):** `codex-runs/2026-10-25-blind-*/analysis.md`. It agrees: port NO runtime code from any of the five. Take a few ideas only: Adport reporting techniques, OOSA templates/brand conventions for P2, a P4 checklist from Postiz.
- [ ] **Codex gap review → revised top 8** (`codex-runs/2026-10-25-gap-review/analysis.md`):
  1. Freeze P0 contracts, merging gaps 1–3 into one reporting workstream.
  2. Prove one Google/Meta lead journey with the real-account check.
  3. P1 results and alerts, including freshness, disapprovals, pacing and reconnect. Reconnect status ALREADY exists in OM.
  4. A lead-focused local launch plus pre-flight.
  5. Qualified/won outcomes back to the platforms, with delivery diagnostics.
  6. A small brand profile plus copy variants.
  7. Waste control: Google search-query report + negative keywords first.
  8. The Apple migration.

  **Missed by the synthesis:**
  - calls, bookings and manual won entry;
  - measurement acceptance (dedupe, click IDs, accepted/processed/attributed shown separately);
  - reporting trust (freshness, lag, restatements);
  - the owner's target cost per lead plus "insufficient data" outcomes;
  - connection-to-launch readiness states.
- [ ] **TIME-BOUND, CONFIRMED by Apple:** Campaign Management API v5 sunsets **2027-01-26** (Apple Ads Platform API Preview Release Notes p.4, https://ads.apple.com/adsdam/app-store/us/en_us/documents/api-preview-guide.pdf#page=4). Migrating needs endpoint shapes, `adAccountId` context and response envelopes (pp.6–7). Migrate or explicitly defer apple-search-ads. Migrate OM's apple-search-ads plugin to Ads Platform API v1 before then.
- [ ] Owner: trademark search for "Open Marketing" before a public launch (OOSA clash).

## HIGH PRIORITY — swap OM infrastructure to Jini (owner, 2026-10-24: "it should use Jini's stuff")
- [ ] **Codex plan first, then a staged swap.** Replace OM-built infrastructure with Jini 0.6.x wherever Jini covers it:
  - **Outbox:** `@jini-ai/infra/events/outbox` (0.5.4, retained owner) in place of OM's `features/jobs` outbox. Keep these invariants: ONE outbox, atomic intent+enqueue, idempotency keys, unknown outcomes never blindly retried.
  - **Outbound webhooks:** `@jini-ai/integrations/webhooks` (subscriptions, delivery worker, signing, keyring).
  - **Scheduling + event log:** `@jini-ai/daemon` scheduler and the sqlite event-log.
  - **Email:** `@jini-ai/platform/mail` (engine, policy, feedback/suppression, sender verification), plus `@jini-ai/platform` aws-sigv4 for SES.
  - **Gap check:** grep OM for any other self-built infra Jini already ships (http guarded fetch, secrets, rate limits, retries) and list it.
  - **Missing from Jini:** propose it as an upstream Jini addition, never an OM-local copy.

## QUEUED — observability extension points (owner, 2026-10-25)
The owner is building Jini adapters for OpenTelemetry, PostHog and Sentry so we can observe data and fix problems. OM needs the same paradigm, consumed from published Jini only.
- [ ] **Jini jobs (tovu-9b, 2026-10-25):** three cloud prototypes, none published yet:
  - Observability 1, `trig_011TCXaeCEWMmrteveG7aZju`: port extension, plus OTel and Sentry on assistant tool calls; branches `cloud/observability-1025-*`; likely finished.
  - Observability 2, `trig_01GwvNHGFS9qExmmcEQyygLc`: OTel and Sentry move into provider plugins, plus a PostHog adapter.
  - Langfuse AI-run tracing, `trig_01KGGir41wJ2xstx2YJR44PE`: contract in Jini agent-runtime, so OM can reuse it; branches `cloud/ai-tracing-1025-*`.
- [ ] **OB1 demo built, NOT committed** (R1 server + R2 studio; typechecks green). Codex brief: `codex-runs/2026-10-25-observability-demo/`. Before/after screenshots are in b5's scratchpad. Agreed with tovu-9b (10-25) to converge on Jini's shape; the fix pass is:
  - **ONE generic decorator per chokepoint:** `withObservability({ api, observability })` over every API method (`trackOperation`/`reportError`). No approve special case in `shared/api/telemetry.ts`.
  - **Remove the hand-written server approve tracker:** in `inbound/owner.ts`, replace it with a chokepoint decorator.
  - **Analytics is a SEPARATE port:** `capture(name, properties)`, primitives only, plus an allowlist/redaction step; injected `track` = `analytics.capture`. Drop the per-event strict union in `packages/contracts/src/telemetry`.
  - **Delete the 22-line `useApprovalExposure`:** fire shown/expired as one-liners where they happen.
  - **Readable times in the Events panel.**
  - **WHO did it (owner, via tovu-9b 10-25):** every tracked operation/event carries `user.id`, the pseudonymous principal id, never email or name. Analytics runs only after consent.
  - **Single-object port inputs:** `capture({ name, properties, userId })` and `trackOperation({ name, attributes })`. The OB1 `track(name, fields)` positional signature must become a single object, which also satisfies the OM lint rule.
  - **Final Jini names:** from tovu-9b after Jini cloud run 2 (~4 PM PT 10-25).
- [ ] **Owner rule:** OTel, Sentry and PostHog are swappable provider plugins, never core. Product analytics sits behind a generic analytics contract.
- [ ] **Expected release:** port shape and version settle at review/merge, probably a Jini 0.6.x after 0.6.14. tovu-9b will send the interface summary and spec path around 4 PM PT. Don't code against branches.
- [ ] **Already available:** OM declares `@jini-ai/diagnostics` 0.6.12, whose `./observability` export has an OTel `ObservabilityPort` + noop + hooks, but OM wires none of it. Tovu's usage is in `apps/website/src/platform/observability/`; DB, outbound-HTTP and agent-run spans are nested under the request span.
- [ ] **OM plan:** inject the port in the server composition (noop by default; on only via explicit config). Then add spans for HTTP, DB, plugin tool calls, vendor dispatch and agent runs. Use the PostHog/Sentry adapters once Jini publishes them. Never send ad-account PII or secrets.

## QUEUED — over-engineering cleanup (Codex audit 2026-10-25)
Full report: `ADS-memory/.local-artifacts/codex-runs/2026-10-25-overengineering-audit/audit.md`, with 20 ranked findings and 7 proposed rule changes (owner decisions). The biggest waste is parallel implementations: old feature stacks stay tested while the server runs a different path.
- [ ] **Batch 1 — mechanical pruning:**
  - delete the unused jini-compat `claimBatch`;
  - drop unused factory dependencies (audit, media, measure);
  - remove the workspace lookup wrappers;
  - remove observer aliases and re-export blocks.
- [ ] **Batch 2 — one SQL/session protocol:** replace the feature-invented SQL shapes, plus one shared SQLite test fixture. Remove the unused PostgreSQL branch if the owner confirms.
- [ ] **Batch 3 — one plugin/federation implementation:** the unconstructed `features/plugins` lifecycle and `features/federation` host duplicate the server path.
- [ ] **Batch 4 — jobs owns every transition:** remove duplicated lease/journal SQL, the policy identity leftovers and the double worker path.
- [ ] **Batch 5 — schema/utility consolidation:** OAuth schemas, media tool schemas, sorted-JSON encoders, observer doubles.
- [ ] **Focused audits (10-25):** `codex-runs/2026-10-25-oe-audit-{plugins,tests,studio-server}/audit.md`.
  - **Plugins:** 23 copies of stream-reading code, 1,392 lines of repeated fixtures, 524 lines of repeated manifest tests, duplicate request paths inside Naver/Pinterest/Yandex, and a hand-rolled MCP server in google-ads.
  - **Tests:** about 300–450 lines; redundant fake adapters added on top of the required memory + real pair, a test-only HTTP fixture, and a forms spike that re-implements production.
  - **Studio/server:** about 400–500 lines; an unused SSE client (115 + 65 test lines), duplicated read-model types, extra chat state, and dead methods. The large server files mostly earn their keep.
  - **Quick wins (by hand):**
    - delete the SSE client;
    - delete `selectModel`, studio `createConversation`, the nav text parser and server `JiniRuntimePort`;
    - remove 3 redundant fake test adapters;
    - delete the Naver duplicate reader;
    - delete the version-literal manifest assertions.
  - **New Jini asks:**
    - a byte-limited Response reader (plugins);
    - `@jini-ai/ui/fetch-query` clock/scheduler injection;
    - `@jini-ai/mcp` `createMcpToolServer` hosting options (frame limit, serial, EOF).
  - **tovu-9b accepted all 3 for Jini 0.6.15 (10-25):** a public bounded-body reader with `onLimit: 'reject'|'truncate'` (default reject, built on #7), fetch-query clock/scheduler injection, and createMcpToolServer `maxFrameBytes`/serial/EOF options. These land in a follow-up round after the current 5 groups.
  - **OM plugin kit (published, bundled per plugin):** bounded-JSON snapshot, CAPI binding schemas, exact money math, and test/conformance helpers.
- [ ] **Simplicity-lens audits (10-25):** `codex-runs/2026-10-25-oe-audit-{features,data-model,tooling-deps,public-surface}/audit.md`. Diminishing returns: about 300–400 + 100–130 (plus 190 config) + 130–170 lines, and no whole tables to drop.
  - **Recurring owner decisions:**
    1. Public signatures can be narrowed (scaffolding isn't frozen forever).
    2. B1 means shared behavior evidence. It doesn't mean extra forwarding adapters or hand-copied type declarations, so types are derived from schemas.
    3. A helper split out without removing branches earns no credit.
    4. Retire j00's scaffold-layout test (`development/tests/skeleton.test.ts`).
  - **Quick wins:**
    - delete the 22 forwarding build configs;
    - remove the orphan dev launcher;
    - delete the agent's unused event client;
    - derive the audit/privacy declarations from their schemas;
    - remove the unused contract declarations;
    - replace the comparator with the Jini export.
- [ ] **Round-3 simplicity audits (10-25):** `codex-runs/2026-10-25-oe-audit-{small-features,server-src,studio,plugins-simplicity}/audit.md`.
  - **Small features:** modest; the duplicated workspace auth/context construction is the main item.
  - **Server:** 200–300 lines (command handling, a test-only coverage formatter, obsolete adapters).
  - **Studio:** 200–250 lines (obsolete chat CSS, repeated theme constants), plus 45–50 after a Jini publish.
  - **Plugins:** Meta's unused hosted-MCP stack, and Google's extra layers.
- [ ] **Owner decision:** adopt the 7 proposed rules (e.g. "every required factory dependency must be read or used"; "retire the superseded implementation before accepting integration").

## Jini swap (2026-10-25): result of the JS1/JS2/JS3 plans
OM already delegates to Jini wherever parity exists. What's left are guarantees Jini lacks. Plans: `codex-runs/2026-10-25-jini-swap-*/plan.md`.
- [x] JS1-A: deleted the unused claimBatch and swapped to Jini `sourceChecksum` (f1c28b0, −160 lines; tests not run because of load).
- [ ] **JS1-B:** remove the unused PostgreSQL transaction path (`jini-compat/db/src/transaction.ts`, `ports.ts` dialect, `tests/db/{transaction,migrations}.test.ts`, `fake-client.ts`). First port the unique release/commit/migration assertions into the SQLite tests (plan stage 2, cap 380 lines). Run when load allows.
- [x] JS2 and JS3 builds skipped (no net deletion now).
- [ ] **Jini upstream asks sent to tovu-9b (10-25)**, all additive/opt-in:
  - outbox fencing, reconciliation and receipts;
  - serial pump;
  - event-log conflicts and transactions;
  - db checked client, denial rollback and whole-batch migrations;
  - MCP max response bytes;
  - plugin pack options;
  - fetchWithTimeout injection;
  - guarded-reader no-follow;
  - exact-secrets redaction.

  After Jini publishes: swap and delete OM's copies (features/jobs outbox, jini-compat db).
  **Asks 1–9 are BUILT and committed (10-25)** on Jini branch `feat/om-upstream-1025` (clone `tovu-integration-clones/jini-om1025`) as patch changesets for 0.6.15. Not published yet; the order is 0.6.13 → 0.6.14 → 0.6.15. Notes for the OM swap:
  - `enqueueWithReceipt` is an interface only, so OM's SQLite and memory outbox adapters need their own conformance tests;
  - `pump.stop()` called from inside a pump callback hangs, so never do that;
  - when any pack option is set, a symlinked plugin source folder is skipped by default;
  - mcp keeps its platform peer range at ^0.6.10, but the bounded reader needs platform ≥0.6.15.

  Wait for the publish, then plan the OM swap (outbox first).
  **Update (10-25):** asks 10–12 are committed too. In ask #1, `enqueueWithReceipt`/`EnqueueReceipt`/the `Tx` generic/`requestDigest` were DROPPED because they were declarations only, with no implementation. Still shipping:
  - fencing (claim → beginDispatch → complete);
  - reconciliation-only recovery;
  - ack failures stay uncertain;
  - the serial pump;
  - `idempotencyKey`.

  b5 asked to add the receipt and caller-owned transaction back WITH an in-memory reference adapter and conformance suite; OM can't delete features/jobs without them.
  ACCEPTED for 0.6.15 (being built): `Tx` on the fenced port, `enqueueWithReceipt({ intent, transaction? })` → inserted|existing|conflict, an exported in-memory reference adapter, and an exported conformance suite (OM's SQLite adapter must pass it). Legacy `enqueue()` is unchanged. tovu-9b sends the final API when it lands.
  **BUILT (jini-om1025 c31264d8 + 2817d057; Codex checking).** API in `@jini-ai/infra/events/outbox`:
  - `FencedEnqueuePort<E, Tx>.enqueueWithReceipt({ intent }, { transaction } = {})` → `{status:'inserted'|'existing'} | {status:'conflict', reason:'request-digest-mismatch'}`;
  - `EnqueueIntent<E> = Intent<E> & { requestDigest }`;
  - `outboxRequestDigest({ request })` (sha-256 of canonicalJson, which now lives in `@jini-ai/core/records`);
  - `InMemoryTransaction` and `InMemoryFencedOutbox<E>`;
  - `fencedOutboxConformance({ createSubject })` → `{ name, run }` cases (node:assert).

  OM's SQLite adapter must run the conformance cases; its own run is what proves uniqueness under racing transactions. Enqueue is a separate port; FencedOutboxPort and the legacy OutboxPort are unchanged. A SQLite lease race was also fixed.
  tovu-9b accepted all 9 (10-25). Target is **Jini 0.6.15**, built in 5 groups: outbox+pump, event-log, db, fetch/mcp/guarded-reader, pack+redact. Each group must prove Tovu's defaults are unchanged. #9 extends the existing `keepIdentifiers` sanitizer option (Jini 31641d1b). tovu-9b reports each group as it lands.

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
- [ ] **Plugin typecheck (b5, 2026-10-25), one folder at a time:** 14 of 16 green. Two fail only on dependencies that aren't installed, because plugin folders aren't workspace members:
  - x-ads needs `oauth-1.0a` 2.2.6;
  - amazon-ses needs `@jini-ai/platform` 0.6.12.

  Fix during the wiring pass (install, or add them to the workspace; this touches the lockfile, so it's integrator-only).
- [ ] **New-plugin wiring pass:** connect all 12 ad plugins and resend-email, twilio-sms, whatsapp-business and amazon-ses to the server (agent-plugin-backends, build script, catalog). Do this AFTER P0 freezes report.metrics.v1.
- [ ] **Messaging plugins R2:** broadcasts, suppression and webhooks for Resend, SES, Twilio and WhatsApp.
  - **Email: REUSE Jini.** Make resend-email and amazon-ses adapter modules for `@jini-ai/platform/mail` 0.6.12, the way Tovu's resend plugin does (`tovu-mail-adapters.json`). It provides the provider registry, purpose-scoped mailer, delivery policy with one-click unsubscribe, rate limits, feedback ingest with suppression, and sender-domain verification. Also use `@jini-ai/platform` aws-sigv4 for SES and `@jini-ai/integrations/webhooks`.
  - **SMS/WhatsApp:** no Jini infrastructure, so they stay plugin-only. A Jini messaging engine is a possible upstream addition.
- [ ] **Official brand logos:** waiting on the owner's OK to use official kits under each vendor's brand guidelines. Then Codex places them in `<plugin>/io.github.ainsep.openmarketing/assets/` (manifest-declared, digested), with the guideline URL recorded per file.
- [x] **Agent Plugins standard:** DONE 2026-10-25 (b5). Every `$schema` is now the published 1.0.0 (1.1.0 returns 404). This covers portable.ts, fixtures, server and tests. `@open-marketing/plugins` typecheck is green; tests not run. The architecture reports still say 1.1.0.
- [ ] **Lint/complexity sweep:** cognitive >10 and nesting >3 errors, plus 19 two-object-argument breaches (see `codex-runs/2026-10-24-complexity/CX1.md`).
- [ ] **Marketing skills:** adapt the top MIT/Apache sources into om-playbook and the vendor plugins (see `codex-runs/2026-10-24-marketing-skills/research.md`). Record license and provenance for each.
- [ ] **Brand logos:** every card uses neutral monograms. Real logos need each vendor's brand-terms acceptance; Google's official button kit is the clean route.
- [ ] **Test quality:** coverage and test-quality audit using Tovu's guidance (`codex-runs/2026-10-24-test-quality/tovu-test-guidance.md`): Stryker, tightened TDD audit prompt, count the tests that actually ran.
- [ ] **T1 full test pass** (owner-approved for the end), then fixes.
- [ ] **P2 .dmg build:** Node 24.2.0 tarball + fresh builds, after everything above.
