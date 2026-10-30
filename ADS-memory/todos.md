# Open Marketing — todos

## ⚡ RESUME HERE (2026-10-28; open-marketing-8b)
**Current remaining work:** `codex-runs/handoff-1028/E1-SESSION-CATALOG.md` §C/§D + `codex-runs/coordinator-notes-1028.md` (open-marketing-8b section). Later coordinator/owner decisions supersede the catalog's old P1 sequencing.
- Required rc.2 jobs → integration pass → commit → push → ONE cloud test → fixes; merging remains owner-controlled. P1 proceeds in parallel; see its roadmap item below.
- **Current wave source is built/post-checked where cited below, uncommitted and untested; nothing from this wave is pushed or cloud-tested.** Individual in-flight jobs and deferred acceptance remain explicit.

## ⚡ STATUS 2026-10-28 — READ FIRST
- The 10-25 wave, 10-26 fixes/round 2 and 10-27 corrections have scoped reports; the old running-wave and defect counts are historical (`codex-runs/2026-10-28-audit-todos/report.md`).
- **Phase A source done except rc.2 mail:** A3-mail + A2d-mail provider construction/host registry/fence → A7 part 2 worker mail binding. `w7-a2d-mail` built descriptors only; `w11-host-meta-cleanup` already excludes host-owned `mailAdapters`. Job dirs below are under `codex-runs/2026-10-28-*` unless dated otherwise.
- **Source follow-ups complete:** A7 part 1 OAuth discovery/boot cleanup (`w13-a7-1b`), mail-provider agent tool + CLI (`w13-provider-settings-tool`) and A6 part 2 (`w12-a6-part2`) are source built, post-checked, uncommitted, untested (their post-check verdicts: READY TO COMMIT). `w13-p1-breakdown/report.md` is complete read-only analysis; its proposed jobs are not implementation evidence.
- **Jini installed: `@jini-ai/*` 0.6.15-rc.2** (bumped from rc.1 by open-marketing-8b 2026-10-28, frozen lockfile); all Jini-user typechecks passed after the bump (`coordinator-notes-1028.md`, 8b section). `@jini-ai/infra` and `@jini-ai/provider-plugins` are not OM dependencies yet.
- **rc.2 contents (installed):** `createDeadlineSignal`, mail `createMailAdapterContext` (now/settings), `canonicalJson`/`canonicalArgumentDigest`. **Not in rc.2:** `ResponseLimitExceededError`, packer `excludeSuffixes`/`includeTests`, the cms jsdom 26/27 peer and the Bash sandbox fix. They come in rc.3/final (tovu-45 correction, `coordinator-notes-1028.md`). Ignore the jsdom peer warning until rc.3.
- Jini contact: **tovu-45**; OM contact: **open-marketing-8b**. Jini changes land in Jini and publish to npm; OM consumes only published versions.
- OM already implements due-time scheduling. Remaining Jini outbox adapter/conformance adoption is tracked under the infrastructure swap and upstream asks below.
- Owner: **NO commit/push yet.**
- **Preserved handoff notes:**
  - `codex-runs/run-phase-retry.sh` line 4 still stubs every `*review` phase to "skipped". If you want Codex reviews, delete that case line and keep `--ignore-user-config`. Don't restore the `.bak`; it predates `--ignore-user-config`.
  - P0-2c's historical complexity/signature findings belong in the final gate sweep below; the dispatch/withdrawal race tests are written, not run (`2026-10-28-audit-todos/report.md`).
  - Remote report branches `test-checkpoint-1025` and `test-cleanup-1025` on ainsep: delete them when no longer needed, but ask the owner first.
  - Studio dev server (was b5's): `cd apps/studio && ./node_modules/.bin/vite --host 127.0.0.1 --port 3005 --strictPort`.

## ⚡ STATUS — integration and acceptance after the source wave
**Historical branches:** `om/clean-slate` was pushed at 55cf681 (P0, QW1–4, DC1, OB2 R1); `om/cleanup-1025` was pushed at 4659d96 (OB2 R2 shared SQL fixture + TF1–5). Those checkpoints predate the current wave.

**Integration pass (after required rc.2 mail jobs):** contracts dist FIRST → plugin/feature dists → fingerprints (including Reddit) → chart dependency locking → lockfile NEEDS → provenance → ONE lint + typechecks → ONE gate/docs job. Source review/post-checks remain required before accepting integration (E1 catalog §C5; latest coordinator notes).
- Build inventory is source built (`2026-10-28-w2-build-inventory`), post-checked, uncommitted, untested; the command covers all 22 executable plugins. Actual builds remain pending.
- Lockfile NEEDS: remove unused `yaml`/`semver`/`zod`/`@jini-ai/agent-plugins` from features/plugins, and Higgsfield's unused `@open-marketing/plugins` devDependency. These differ from the completed QW1 removals (catalog §C5; coordinator notes).
- Rebuild stale plugin/feature distributions and refresh **593 provenance entries** before cloud testing; source completion is not artifact acceptance.
- Gate/docs job: Microsoft CAPI dispatch complexity; TikTok cosmetics/dead `haltStopPermit` and evidence prose; Google/Microsoft stale prose and Microsoft skill token wording; skeleton Meta manifest compatibility. The A6p2 assertion-order fix is already applied; don't re-add it unless lint/cloud flags it (latest 8b notes).
- Observability facade/providers and Jini outbox adoption remain separate below. Cloud `om:check`, test quality/coverage and Mac .dmg acceptance remain open.

**Owner decisions / pointers:**
- seven simplicity rules adopted → cleanup owner-decision item below;
- theme default → OM Ink visual-acceptance item below;
- trademark and official logos → their DEFERRED items below;
- `composition/addons.ts:160` trusting the plugin's own `admitted` flag is intended under unrestricted plugins (owner-approved 2026-10-28; code comment handled separately).
- delete /Users/la/Programming/autofix.log.

**Rules learned today:**
- never run tests on this machine (cloud only); Agent `isolation:"remote"` silently ran locally once;
- never run a non-frozen pnpm install (hand-edit the lockfile importer, then frozen install);
- Codex runs use `--ignore-user-config` (no MCP servers);
- every Codex brief carries the Jini CAPABILITIES.md pointer and the P0 lessons (`ADS-memory/reports/2026-10-25-p0-lessons.md`).


Updated 2026-10-28 for open-marketing-8b (W13; approved audit §5 plus later coordinator evidence). Newest priorities first.

## HIGH PRIORITY — next Codex credits: roadmap Phases 0–4
The full plan is in `ADS-memory/reports/2026-10-24-om-roadmap-phases.md`. The debate merged it to 5 phases, P0–P4.

- [x] **Architecture debate 2026-10-25 — accepted by owner** (Opus 5.5 / Codex 6.1 Sol / Gemini 4 Argon, including the final round-3 ballot): `ADS-memory/reports/2026-10-25-om-architecture-debate.md`.
  - **3–0:**
    - `leads` slice;
    - one capability catalog + invoker;
    - `CampaignKey`;
    - jobs due time;
    - consent subject lane;
    - metrics structure;
    - v2-only launches.
  - **2–1:** reporting in `measure`; a P2 `brand` slice; alerts as a server module.
  - **OWNER DECIDED (10-25):** accepted all of it.
    - Reporting in `measure`.
    - Money in integer micros.
    - No v1 compatibility: launch v2 replaces v1.
    - P0-1 contracts completed; see the committed P0 ledger below.
- [x] **Owner decision:** reporting goes in `measure` (2026-10-25; the vote was 3–0 in round 3).
- [x] **P0 DONE 2026-10-25** (typechecks green; most tests not yet run):
  - P0-1 contracts 5f9c781 + launch v2 b15fa55;
  - P0-2a dispatchDecision aa2f790;
  - P0-2b approver identity 4baff3d (+3c20f0e);
  - P0-2c consent barrier + subject lane 5c2b8c8;
  - P0-2d jobs availableAt 124d607.

  P0-3 asks were filed; publication/installed-version/consumer status is consolidated under Known Jini asks below. OM due-time scheduling is already implemented; only the Jini fenced-outbox adapter/conformance adoption remains under the swap.
- [x] (original P0 item) **P0 Contracts frozen and committed** (P0 ledger above; upstream request filed separately):
  - approver/actor contract;
  - `report.metrics.v1` (per-campaign, per-day);
  - capability IDs;
  - NeutralCampaignLaunch v2;
  - consent/erasure dispatch barrier;
  - upstream Jini request for an instance-injected permission catalog.
- [ ] **Pre-P1 check — BLOCKED on Google/Meta accounts:** 1–2 days read-only on one real Google account and one real Meta account. Spend must match the vendor dashboards within ~1%, and a test lead must be credited to the right campaign. Real-account reconciliation remains a release gate for Results.
- [ ] **P1 "Know if my ads work" — START NOW, in parallel with remaining Phase A/Jini work** (owner 2026-10-28; `codex-runs/2026-10-28-w13-p1-breakdown/report.md` now lists the proposed job split, analysis only):
  - Snippet/collection, CampaignKey/UTM handling, leads/reporting backends and local-token approval identity exist (`2026-10-25-w-p1-{web-events,leads}`, `2026-10-25-w2-p1-reporting`, P0 ledger); this is not product acceptance.
  - Remaining: production reporting bindings, destination/tracking readiness surfaces, lead inbox and per-campaign Results through HTTP + studio + om CLI/MCP, Jini owner-identity binding, then real-account acceptance (P1 breakdown §1/§2).
  - Three-alert evaluation/requeue, provider selection and its tool/CLI are source built (`2026-10-28-w7-a5-alerts`, `w12-a7-composition`, `w12-a6-part2`, `w13-provider-settings-tool`), post-checked, uncommitted, untested. Mail delivery still needs rc.2 A3-mail + A2d-mail + A7 part 2.
  - **Coordinator decisions, owner-delegated 2026-10-28:** halt keeps ending in reconcile (fail-safe; revisit with real accounts); alert From address = owner setting with plugin-manifest `alertFrom` as default (verified sender domain), landing with rc.2 mail/P1; mail-provider changes need a fresh owner card every time (`ownerOnly`).
  - **Snapchat reporting decision (2026-10-28):** cap by ≤31 local calendar days, replacing the 744-elapsed-hour guard built in `w2-plugin-minors`; verify against Snapchat docs in the P1 reporting job so DST does not refuse a 31-day report. Job: `2026-10-28-w14-p1-9-snapchat-cap` (building; Snap docs: DAY windows within 31 days in the account time zone).
- [ ] **P2 "Launch better and close the loop" — backend/content partly built:**
  - Qualified/won conversion and brand backends exist (`2026-10-25-w2-offline-conv`, `2026-10-25-w2-brand`); connect outcomes, delivery diagnostics and brand/catalog product surfaces.
  - Finish leads/sales launch translations, local targeting and exact-plan `campaign.validate.v1` pre-flight/card binding.
  - Close declared metrics/status gaps rather than claiming all 16 plugins support `report.metrics.v1`: Apple reporting rows were removed (`2026-10-28-w10-cleanup-small-plugins`); VK/Amazon gaps and LINE null spend still need acceptance (`2026-10-28-audit-todos/report.md`).
- [ ] **P3 "Optimise and scale" — methods in skills; product calculations/execution still open:**
  - optimisation proposals, starting with Google search-query report + negative keywords;
  - A/B execution/readout, sample-size and fatigue calculations in code (`2026-10-25-w2-skills2` provides methods only);
  - CRM sync — choice DEFERRED by owner 2026-10-28;
  - weekly report;
  - teams/agency via Jini user-management.
- [ ] **P4 "Grow beyond paid" — plugin pieces exist; product workflows remain:**
  - audiences;
  - messaging journeys (Resend/Twilio/WhatsApp/SES), consent-authorized durable sends and hosted webhooks; see Messaging R2 below;
  - organic social and Google Business Profile publication (unsupported placeholder rows were removed in `2026-10-28-w10-cleanup-small-plugins`; this is not a working publishing workflow);
  - multi-touch attribution, only if the data warrants it.

## HIGH PRIORITY (later) — gap analysis vs open-source ad tools — HELD (owner, 2026-10-28)
Recon is done; further gap review remains HELD until the owner releases it. License rules: MIT/Apache can be adapted with provenance; AGPL (Postiz) is reference-only, never copy code. Recon docs are in `/Users/la/Programming/OSS-Marketing-Repos/docs` (combined synthesis below; verified by `2026-10-28-audit-todos/report.md`).
- [x] Agentic Ads Studio (MIT): recon done; AI-generated ads, campaign management, Meta/Google/TikTok integrations.
- [x] Adport (Apache 2.0): recon done; agentic ad management across 11 platforms over MCP and CLI.
- [x] OpenAdKit (MIT): recon done; AI ad copy, campaign planning, creative optimisation.
- [x] Postiz (AGPL 3.0): recon done; AI-assisted social posting, scheduling, analytics. Reference only.
- [x] Open Marketing / OOSA (MIT): recon done; AI brand kits, marketing creatives, ad images. Name clearance stays separate.
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
- [ ] **Codex gap review → revised top 8 — analysis done; residual delivery below** (`codex-runs/2026-10-25-gap-review/analysis.md`, current disposition in `2026-10-28-audit-todos/report.md`; no new gap review):
  1. DONE: P0 contracts frozen and committed; reporting is one workstream in measure.
  2. Prove one Google/Meta lead journey — account-blocked at the Pre-P1 check.
  3. Close P1 Results/alerts surfaces and mail, including freshness, disapprovals, pacing and existing reconnect status.
  4. Finish a lead-focused local launch plus pre-flight.
  5. Wire qualified/won outcomes to the platforms and expose delivery diagnostics; conversion backend exists.
  6. Expose the built brand profile/copy content through product surfaces (`2026-10-25-w2-brand`, `2026-10-25-w-ad-copy-skill`).
  7. Waste control: Google search-query report + negative keywords first.
  8. DONE: Apple migration implementation committed; integration/acceptance remains in its item below.

  **Missed by the synthesis:**
  - calls, bookings and manual won entry;
  - measurement acceptance (dedupe, click IDs, accepted/processed/attributed shown separately);
  - reporting trust (freshness, lag, restatements);
  - the owner's target cost per lead plus "insufficient data" outcomes;
  - connection-to-launch readiness states.
- [x] **Apple v1 migration BUILT and committed 2026-10-25** (reporting stays not_implemented until Apple's semantics are confirmed; plugin still disabled pending integration). Original item: **TIME-BOUND, CONFIRMED by Apple:** Campaign Management API v5 sunsets **2027-01-26** (Apple Ads Platform API Preview Release Notes p.4, https://ads.apple.com/adsdam/app-store/us/en_us/documents/api-preview-guide.pdf#page=4). Migrating needs endpoint shapes, `adAccountId` context and response envelopes (pp.6–7). Migrate or explicitly defer apple-search-ads. Migrate OM's apple-search-ads plugin to Ads Platform API v1 before then.
- [ ] **DEFERRED by owner 2026-10-28:** trademark search for "Open Marketing" before a public launch (OOSA clash).
- [ ] **More Studio themes** (owner 2026-10-29, later): add a Linear-style theme (dark-first, near-black surfaces, light-gray type, subtle 1px borders, violet accent, tight radii, dense spacing) and an Apple-style theme (#f5f5f7 backgrounds, white cards, system type, soft shadows, larger radii, black/white with blue accent) as token files in `apps/studio/src/themes/` + `registry.ts`; use neutral names (e.g. "Precision", "Studio Light"), not brand names.
- [ ] **Themes as installable plugins** (owner 2026-10-29, later): make theme packs installable/uploadable like other plugins (tokens only), ideally a shared Jini theme-pack plugin (Tovu has `tovu-theme`) per the plugin-extraction rule.
- [ ] **Higgsfield from Jini** (owner 2026-10-29): replace OM's forked higgsfield-media adapter with the shared Jini/Tovu plugin (mcp.json → mcp.higgsfield.ai via Jini MCP federation) once Jini publishes it; keep OM's spend approval card for paid generations (preflight `get_cost:true` → show credits → approve → submit; quote ≠ permission). Jini: rc.3 or the rc after.
- [ ] **Marketing video at ainsep.com/open-marketing** (owner 2026-10-29): a product marketing video for Open Marketing, hosted on the page ainsep.com/open-marketing.

## HIGH PRIORITY — swap OM infrastructure to Jini (owner, 2026-10-24: "it should use Jini's stuff")
- [ ] **Staged Jini adoption — rc.2 installed; remaining swaps need semantic parity.** Audit: `codex-runs/2026-10-28-w6-audit-jini-local/report.md`; later decisions: `coordinator-notes-1028.md` (e1 adoption trims and latest 8b/tovu-45 update).
  - **Outbox R1 OPEN:** add published `@jini-ai/infra` (not an OM dependency yet), then adapt `@jini-ai/infra/events/outbox` to OM's jobs boundary and pass `fencedOutboxConformance`. Keep these invariants: ONE outbox, atomic intent+enqueue, idempotency keys, unknown outcomes never blindly retried.
  - **Outbound webhooks:** `@jini-ai/integrations/webhooks` (subscriptions, delivery worker, signing, keyring).
  - **Scheduling + event log:** `@jini-ai/daemon` scheduler and the sqlite event-log.
  - **Email:** `@jini-ai/platform/mail` (engine, policy, feedback/suppression, sender verification), plus `@jini-ai/platform` aws-sigv4 for SES; rc.2's `createMailAdapterContext` (installed) unlocks A3-mail/A2d-mail and A7 part 2 (`2026-10-28-w15-a3-mail`, in flight).
  - **Audit dispositions:** R4 om-db and R7 Google stdio adoption: nothing to build (`w8-jini-omdb`, `w8-jini-gads-stdio`, skipped-no-build); the obsolete stdio surface was later deleted by `w10-cleanup-google-ms`.
  - **Readers R5:** two agent readers are source built (`w8-jini-app-readers`), post-checked, uncommitted, untested. Plugin readers A/B and server readers wait for rc.3/final (`ResponseLimitExceededError` is not in rc.2; preserve each plugin's BOM/UTF-8/error semantics and add required dependencies through the integrator).
  - **Packing R9:** `w8-jini-packing` built nothing against rc.1; revive after rc.3/final supplies `excludeSuffixes`/`includeTests` and allow-path precedence (not in rc.2). Keep reseeding; early dedup was not added upstream.
  - **Deadline/digest:** adopt rc.2's `createDeadlineSignal` in Twilio/WhatsApp/X through the integrator (`2026-10-28-w15-deadline`, in flight). Digest DECIDED (8b, 2026-10-28): keep contracts `canonicalizeArguments` (sync, used by safety + plugins; contracts stays pure). Jini's `canonicalArgumentDigest` is async, so there is no swap and no job. Revisit only if Jini adds a sync digest.
  - **Missing from Jini:** propose it as an upstream Jini addition, never an OM-local copy.

## QUEUED — observability extension points (owner, 2026-10-25)
The owner is building Jini adapters for OpenTelemetry, PostHog and Sentry so we can observe data and fix problems. OM needs the same paradigm, consumed from published Jini only.
- [ ] **OB1 demo committed in 4016dbe; facade-aligned fix pass remains.** Brief: `codex-runs/2026-10-25-observability-demo/`. Reuse Jini's single `deps.tracker` facade (`capture`/`error`/`span`); remove remaining approval-specific tracking/exposure plumbing and simplify schemas as part of that adoption, without inventing another OM port.
  - Readable Events times are source built (`codex-runs/2026-10-28-w2-event-times`), post-checked, uncommitted, untested; no remaining timestamp implementation task.
  - **WHO did it (owner, via tovu-9b 10-25):** every tracked operation/event carries `user.id`, the pseudonymous principal id, never email or name. Analytics runs only after consent.
  - **Single-object inputs** remain required; align calls to the published facade instead of preserving the obsolete separate analytics-port design.
- [x] **Owner rule accepted:** OTel, Sentry and PostHog are swappable provider plugins, never core. Product analytics uses the generic published Jini contract. Don't code against branches. Adoption/acceptance is the separate open item below.
- [ ] **Available vs adopted:** OM has `@jini-ai/diagnostics` 0.6.15-rc.2; Studio telemetry and owner approval tracking already use observability. The published `./observability/node` `createTracker` facade is available; `@jini-ai/provider-plugins` is not an OM dependency yet (`2026-10-28-w6-audit-jini-local/report.md`, E1 catalog §D).
- [ ] **OM adoption:** wire the published tracker at composition (noop by default; explicit configuration to enable providers), then HTTP, DB, plugin tool calls, vendor dispatch and agent-run spans. Add the published provider package through the integrator; prove identity, consent and redaction at the boundaries. Never send ad-account PII or secrets. The separate cookie-consent redesign must not be rebuilt on the old consent/browser-analytics bridge.

## QUEUED — over-engineering cleanup (Codex audit 2026-10-25)
- [x] **Quick wins DONE 2026-10-25, about −1,200 net lines; typechecks green, tests not run:**
  - JS1-A f1c28b0;
  - QW1 313c3e8 (studio/agent/tooling, −593);
  - QW2 2900f9c (features/tests, −186);
  - QW3 a7b3356 (server + JS1-B, −245);
  - QW4 eb65a0b (plugins, −29).
- [x] **Integrator follow-up from QW1 — named removals verified** (`codex-runs/2026-10-28-audit-todos/report.md`): root/agent/desktop/plugins/federation manifests are clean of the historical unused declarations. The five remaining `om-clock` declarations in forms/measure/jobs/privacy/policy have real callers. QW1 is committed in 313c3e8; the different current lockfile NEEDS are under the integration pass above.
Full report: `ADS-memory/.local-artifacts/codex-runs/2026-10-25-overengineering-audit/audit.md`, with 20 ranked findings and 7 proposed rule changes (owner decisions). The biggest waste is parallel implementations: old feature stacks stay tested while the server runs a different path.
- [ ] **Batch 1 — mechanical pruning:**
  - `claimBatch` is committed gone (JS1-A); workspace wrappers/schema derivations and audit/media/measure factory dependency cleanup are source built (`2026-10-28-prune-batch1`, `2026-10-28-w2-factory-tail`), post-checked, uncommitted, untested. Measure's stale HANDOFF claims were corrected by factory-tail FIX 8.
  - **Only residual:** observer aliases/re-export blocks, deferred to the later barrel batch (`prune-batch1/postcheck.md`, including audit's optional internal schema re-export).
- [x] **Batch 2 — one SQL/session protocol, source built and post-checked** (`packages/om-db` shared fixture committed in 4659d96; canonical feature `SqlSession` aliases are uncommitted wave source; `2026-10-28-audit-todos/report.md`), untested. The unused PostgreSQL branch is already removed (JS1-B); cloud conformance remains separate.
- [ ] **Batch 3 — lifecycle consolidated; federation residual:** oe3 option A puts plugin lifecycle in the feature slice (`2026-10-27-r3-oe3fix`). Inspector retirement is source built (`2026-10-28-oe-inspector-stack`), post-checked, uncommitted, untested; server federation orchestration vs exported feature host still needs consolidation.
  - Inspector's Higgsfield test/docs tail and ZIP/NUL boundary tests are source built (`w2-higgsfield-tail`, `w2-upload-boundary-tests`), post-checked, uncommitted, untested. Remaining out-of-lane inspector actions: obsolete Meta portable suite/docs, integration-pass unused dependencies, and N6 MCP server-entry validation parity. Owner admission intent is recorded above.
- [x] **Batch 4 — jobs owns every transition, scoped source cleanup built** (`codex-runs/2026-10-25-w-oe4-jobs`, verified by `2026-10-28-audit-todos/report.md`), post-checked, uncommitted, untested: jobs owns lease/checkpoint operations, policy identity leftovers and the duplicate worker path are removed. Jini cutover/cloud acceptance remain separate.
- [ ] **Batch 5 — schemas/utilities partly consolidated:** OAuth/media schemas are source built (`2026-10-25-w-oe5-schemas`); safety reuses contracts' canonical serializer (`2026-10-28-w5-contracts-helpers`) and LinkedIn uses it (`w10-cleanup-tiktok-li`), post-checked, uncommitted, untested. Remaining sorted-JSON/observer consolidation must preserve durable digest bytes; contracts `canonicalizeArguments` stays (rc.2's digest is async; decision under the Jini swap item).
- [ ] **Focused audits (10-25) — analysis DONE, selected actions built:** `codex-runs/2026-10-25-oe-audit-{plugins,tests,studio-server}/audit.md`.
  - Mechanical quick wins are complete per `2026-10-28-audit-todos/report.md`; duplicated factory fixtures are trimmed (`2026-10-28-oe-test-trims`), post-checked, uncommitted, untested.
  - Agent reader adoption is built (`w8-jini-app-readers`); plugin/server readers await rc.3/final and their semantic keep-lists. Google stdio was deleted (`w10-cleanup-google-ms`), so no independent hosting replacement remains.
  - Re-check remaining fixture/manifest duplication and Naver/Pinterest/Yandex paths individually before deleting; old aggregate counts are not a current backlog. Keep required shared memory/real behavior suites.
  - Bounded readers, fetch-query clock/scheduler injection and MCP hosting controls are published in rc.1; adoption dispositions are under the Jini swap/ask checklist. Reuse contracts' bounded-JSON/CAPI/money helpers and existing suites, not a new plugin kit.
- [ ] **Simplicity-lens audits (10-25) — analysis DONE:** `codex-runs/2026-10-25-oe-audit-{features,data-model,tooling-deps,public-surface}/audit.md`.
  - **Recurring owner decisions:**
    1. Public signatures can be narrowed (scaffolding isn't frozen forever).
    2. B1 means shared behavior evidence. It doesn't mean extra forwarding adapters or hand-copied type declarations, so types are derived from schemas.
    3. A helper split out without removing branches earns no credit.
    4. Retire j00's scaffold-layout test (`development/tests/skeleton.test.ts`).
  - Build-config/launcher/event-client deletions, audit/privacy schema derivation and Jini comparator reuse are complete (`2026-10-28-audit-todos/report.md`, `2026-10-28-prune-batch1`, post-checked, uncommitted wave work, untested). Remaining: the eight unused contracts declarations and aliases/barrels through their integrator/later batch; scaffold-layout coverage must be retired without losing useful assertions.
- [ ] **Round-3 simplicity audits (10-25) — analysis DONE:** `codex-runs/2026-10-25-oe-audit-{small-features,server-src,studio,plugins-simplicity}/audit.md`.
  - Selected server/studio simplifications and shared owner HTTP/tool presentation are source built (`2026-10-28-hot-server-composition`, `hot-studio`, `oe-owner-presentation`), post-checked, uncommitted, untested. No current hotspot count is established by the old estimates.
  - Google stdio/extra compatibility layers and Meta/TikTok/LinkedIn transitional paths are removed (`w10-cleanup-google-ms`, `w10-cleanup-tiktok-li`, `w11-host-meta-cleanup`), post-checked, uncommitted, untested. Remaining workspace context duplication, aliases and other unassigned findings need a scoped reference check; don't reopen those deleted stacks.
- [x] **Owner decision:** adopt the 7 proposed rules — **adopted 2026-10-28; now `development/COMMON.md §13`** (e.g. "every required factory dependency must be read or used"; "retire the superseded implementation before accepting integration").

## Jini swap (2026-10-25): result of the JS1/JS2/JS3 plans
OM already delegates to Jini wherever parity exists. What's left are guarantees Jini lacks. Plans: `codex-runs/2026-10-25-jini-swap-*/plan.md`.
- [x] JS1-A: deleted the unused claimBatch and swapped to Jini `sourceChecksum` (f1c28b0, −160 lines; tests not run because of load).
- [x] **JS1-B DONE** (a7b3356, with QW3). Was: remove the unused PostgreSQL transaction path (`jini-compat/db/src/transaction.ts`, `ports.ts` dialect, `tests/db/{transaction,migrations}.test.ts`, `fake-client.ts`). First port the unique release/commit/migration assertions into the SQLite tests (plan stage 2, cap 380 lines). Run when load allows.
- [x] JS2 and JS3 builds skipped (no net deletion now).
- [x] **Jini upstream asks filed/accepted (10-25)**, all additive/opt-in; in **0.6.15-rc.1; rc.2 installed; OM adoption pending** (`@jini-ai/infra` itself is not yet an OM dependency). Keep the adapter/conformance work under the staged swap above; this tick closes filing, not adoption:
  - outbox fencing, reconciliation and receipts;
  - serial pump;
  - event-log conflicts and transactions;
  - db checked client, denial rollback and whole-batch migrations;
  - MCP max response bytes;
  - plugin pack options;
  - fetchWithTimeout injection;
  - guarded-reader no-follow;
  - exact-secrets redaction.

  In 0.6.15-rc.1; rc.2 installed; OM adoption pending: swap and delete OM's copies (features/jobs outbox, jini-compat db) only where parity is established.
  **Asks 1–9 are BUILT and committed (10-25)** on Jini branch `feat/om-upstream-1025` (clone `tovu-integration-clones/jini-om1025`) as patch changesets for 0.6.15. In 0.6.15-rc.1; rc.2 installed; OM adoption pending. Notes for the OM swap:
  - `enqueueWithReceipt` is an interface only, so OM's SQLite and memory outbox adapters need their own conformance tests;
  - `pump.stop()` called from inside a pump callback hangs, so never do that;
  - when any pack option is set, a symlinked plugin source folder is skipped by default;
  - mcp keeps its platform peer range at ^0.6.10, but the bounded reader needs platform ≥0.6.15.

  In 0.6.15-rc.1; rc.2 installed; OM adoption pending (outbox first, after semantic-parity review).
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

  OM's SQLite adapter must run the conformance cases; its own run is what proves uniqueness under racing transactions.
  **FINAL (tovu-dd, 10-25, Jini 4bd32f8c):**
  - `FencedConformanceSubject<E, Tx>` now REQUIRES `conflictingEvent` (deep-unequal to `event`), with an optional `awaitOverlap({ transaction })` for adapters with concurrent transactions.
  - A key held by an open transaction is never inserted twice. An abandoned open transaction keeps its key reserved, so ALWAYS settle transactions in `finally`.
  - A failed InMemoryTransaction commit runs every rollback; several errors become an AggregateError.
  - New overlap conformance case.

  In 0.6.15-rc.1; rc.2 installed; OM adoption pending. Enqueue is a separate port; FencedOutboxPort and the legacy OutboxPort are unchanged. A SQLite lease race was also fixed.
  tovu-9b accepted all 9 (10-25). Target is **Jini 0.6.15**, built in 5 groups: outbox+pump, event-log, db, fetch/mcp/guarded-reader, pack+redact. Each group must prove Tovu's defaults are unchanged. #9 extends the existing `keepIdentifiers` sanitizer option (Jini 31641d1b). tovu-9b reports each group as it lands.

## QUEUED — Tovu → Jini extraction audit (owner, 2026-10-24)
OM is now Jini's second consumer, so rule-of-two applies. Find Tovu code that is abstract enough to live in Jini and be reused by OM; don't copy it into OM.
- [x] Codex inventory (read-only) of Tovu ↔ OM overlaps DONE: `ADS-memory/reports/2026-10-25-tovu-jini-extraction-audit.md` (nine ranked candidates). Extraction/publication/OM adoption remain separate. Candidates:
  - credential/connection cards (Tovu credential-cards.ts, connect-card-ui.ts);
  - site guide + capability cards;
  - chat-pane wiring/hooks (Tovu App.tsx/panels.tsx);
  - admin theme registry + accent swatches;
  - sidebar empty-click/rail hooks;
  - plugin admin-surfaces/exports host;
  - mail adapters (tovu-mail-adapters.json);
  - test-rigor/coverage scripts;
  - per-route tool-coverage parity checks.
- [ ] **Known Jini asks — one publication / installed-version / OM-consumer checklist** (requesting is done; consolidate the former upstream chat/permission duplicate here):
  - **Permission catalog:** filed/built upstream (`ADS-memory/reports/2026-10-26-jini-asks-p0-3.md`); OM consumes rc.2, but user-management is not an OM server dependency (`w13-p1-breakdown/report.md`). Exact released injection API/installed-version/consumer adoption still needs confirmation.
  - **Vendor/effort pickers, authoritative chat cost and runtime effort:** requests filed; chat/agent-runtime installed at rc.2. Existing OM pickers/usage presentation do not establish acceptance of the exact upstream asks; publication/export and consumer closure remain unverified.
  - **Messaging/SMS engine:** requested, no published/installed engine or OM adoption established. Keep SMS/WhatsApp plugin-only until a published fit exists.
  - **Fenced outbox / telemetry facade/providers:** rc.1 published; diagnostics installed, infra/provider-plugins absent. Outbox parity/conformance and tracker/provider adoption are the open swap items above.
  - **Mail context / deadline / canonical digest:** in rc.2 (installed 2026-10-28). Mail goes through `w15-a3-mail` and deadline through `w15-deadline`; the digest stays contracts `canonicalizeArguments` (sync). **Packer options / typed reader error / cms jsdom peer:** rc.3/final, not yet published; packing and plugin/server readers wait for it (tovu-45 correction, `coordinator-notes-1028.md`).

## QUEUED — OM's own design system theme: sleek black and white (owner, 2026-10-24)
- [x] **OM Ink theme source built** (`codex-runs/2026-10-25-w-bw-theme`, checked by `2026-10-28-audit-todos/report.md`), post-checked, uncommitted, untested. Sleek black and white: black-on-white in light mode, white-on-black in dark mode, with its own design-system values:
  - font pair (display + text; installed or OFL webfonts);
  - neutral palette + a single restrained accent (or none);
  - radius, border, shadow and spacing scale;
  - nav and metric treatments.
- [x] **Token-only theme implementation proven:** OM Ink needed ZERO component styling edits (`2026-10-25-w-bw-theme`, checked by `2026-10-28-audit-todos/report.md`), post-checked, uncommitted, untested. Broader hard-coded layout dimensions remain a token-contract limitation.
- [ ] **OM Ink stays an additional theme** (owner 2026-10-26); Modern remains the default. Browser/contrast acceptance is pending; visual adjustments must change tokens only.

## QUEUED — marketing skills as agent plugins (owner-approved shape, 2026-10-24)
Sources: `codex-runs/2026-10-24-marketing-skills/research.md`. Only MIT/Apache sources; each plugin gets a PROVENANCE.md (repo, commit, license, changes). Strip tool/host assumptions and any instruction that escalates tools.
- [x] **1. General marketing → `om-playbook`, source built** (`codex-runs/2026-10-25-w2-skills2`, `2026-10-25-w-ad-copy-skill`, checked by `2026-10-28-audit-todos/report.md`), post-checked, uncommitted, untested. Adapted with per-skill provenance from Corey Haines, Anthropic and Aaron:
  - strategy and briefs;
  - copywriting;
  - landing-page CRO;
  - analytics/attribution;
  - ad creative testing.
- [ ] **2. Platform-specific skills — selected adaptations built; content acceptance/follow-ups remain:** 14 vendor skills with provenance live in each vendor's agent plugin (`2026-10-28-w2-vendor-skills`, `w6-skills-a/b/c/d`; post-checked, uncommitted, untested). Keep Higgsfield's existing provenance. Remaining: VK primary-source facts from `ads.vk.ru/help`, and Microsoft developer-token wording in the integration gate/docs job; general operational updates landed with the plugin cleanups (coordinator notes, e1/8b). Do not reopen the completed adaptation batch.
- [x] **3. Topic add-ons `seo` + `email-lifecycle`, source built** (`codex-runs/2026-10-25-w2-topic-plugins`, checked by `2026-10-28-audit-todos/report.md`), post-checked, uncommitted, untested; packaged skills and provenance exist.
  - Optional `social-publishing` (Publora) remains a DEFERRED candidate; not part of the completed pair.
- [x] **Skill discovery already covers the small-router need:** seven-link playbook hub, `site_guide` and chat add-on discovery (`2026-10-27-r3-small`, verified by `2026-10-28-audit-todos/report.md`), post-checked, uncommitted, untested. Runtime activation still needs acceptance; no new routing framework.

## QUEUED — more chart plugins (owner: "visualization is really important")
- [x] **Downloadable chart PLUGINS built** through Jini's chart contract, **never npm deps in OM** (owner decisions 4 and 10): Recharts, ECharts and Chart.js, bundled/seeded/packaged alike (owner 2026-10-26). Source/artifacts built (`2026-10-25-w-chart-plugins`, `2026-10-28-audit-todos/report.md`), post-checked, uncommitted, untested; artifacts are not cloud/browser acceptance.
- [x] **Owner pick (2026-10-24): Apache ECharts and Chart.js — artifacts built** (`content/plugins/charts-{echarts,chartjs}/0.1.0`, `2026-10-25-w-chart-plugins`, verified by `2026-10-28-audit-todos/report.md`), post-checked, uncommitted, untested. Source dependency locking remains an integration-pass task (`2026-10-28-w3-gates-charts/postcheck.md`).
- [ ] **DEFERRED by owner 2026-10-28:** OpenUI (https://github.com/thesysdev/openui), experimental generative UI; evaluate before adopting.
- [ ] **Chart product acceptance:** A2UI chat provider path exists; Results dashboard use/rendering and browser acceptance remain. Lock reproducible chart dependencies in the integration pass before rebuilding.

## Finish the stopped plugin pipelines (automation stopped 2026-10-24 23:xx)
Check each `codex-runs/2026-10-24-plugin-<p>/` folder's R1/R2 status, review and fix files, then commit what is reviewed and typechecks. The scripts `autocr-plugins*.sh` and `autofix-plugins*.sh` can be restarted to finish the loop.
- [x] DONE (verified 2026-10-25): all 12 ad plugins have R1 (reads + auth) and R2 (paused launch + readback) reviewed and committed. Resend, Twilio, WhatsApp and SES have R1 reviewed and committed. This is a historical per-plugin compile snapshot; current host wiring and residuals are below.

## In progress / next (carried from 2026-10-24)
- [ ] **Chat panel parity, remaining acceptance.** The header controls, dock/pickers, icon CSS, flatter approval card and status/usage paths exist (`codex-runs/2026-10-25-w-chat-polish`, `2026-10-28-audit-todos/report.md`), post-checked, uncommitted wave source, untested. Remaining: image attachment transport + UI (currently rejected by session), real-run/usage acceptance and a browser comparison with the owner's screenshots. Visual adjustments should change CSS values only.
- [ ] **Chat panel parity with Tovu (owner's top UI item).** Use `codex-runs/2026-10-24-jini-upgrade/owner-feedback-2254.md` and adjacent screenshots as acceptance evidence; the remaining work is the attachment/live-run/visual pass above, plus authoritative upstream usage integration. CB1 R1's old "under review" status is obsolete; CB1 R2 attachment closure is still outstanding. Track upstream publication/adoption once under Known Jini asks.
- [ ] **Commit in-flight work after verification — BLOCKED on the integration/release procedure above.** Keep explicit-path batches and owner authorization; no stage/commit/push/merge is authorized by this checklist refresh. Byte import remains deferred for Higgsfield; source/typecheck reports do not prove runtime acceptance.
- [ ] **Vendor cards R2 — generic cards/extra fields source built:** generic plugin-secret/OAuth handling, Studio cards/provider selection and mail-provider tool/CLI exist (`2026-10-28-w6-secret-attach`, `w6-a6-studio-cards`, `w12-a6-part2`, `w13-provider-settings-tool`), post-checked, uncommitted, untested. Remaining: end-to-end card/status/credential acceptance. Official logos remain separate.
- [x] **Historical X/SES dependency blockers resolved:** installed `oauth-1.0a` 2.2.6 and `@jini-ai/platform` (now rc.2); scoped compile evidence in `2026-10-27-r3-plugins-d`, `2026-10-27-r3-messaging-measure`, verified by `2026-10-28-audit-todos/report.md`. Post-checked source/dependency changes remain uncommitted and untested; this is not a fresh global compile claim.
- [ ] **New-plugin wiring — native ABI/dispatcher source built; integration/mail acceptance remains.** A2a-tools + A2b/c/d, A3 native tool/deploy/halt/conversion dispatch and post-A3 transitional cleanup are source built (`2026-10-28-vn-a2a-tools`, `vn-a3-dispatcher`, `w7-a3-b2`, `w10-cleanup-*`, `w11-host-meta-cleanup`), post-checked, uncommitted, untested. Microsoft bound-secret delivery is already complete (`w6-secret-attach`, `w10-cleanup-google-ms`); don't revive the vendor-specific host handoff. Build inventory is complete; actual bundles/fingerprints/provenance/admission acceptance and rc.2 mail remain in the integration sequence above. A7 part 1 (`w13-a7-1b`) is source built, post-checked, uncommitted, untested; later OAuth uploads/removals need restart (accepted post-check limitation).
- [ ] **Messaging plugins R2 — plugin broadcasts/suppression/webhook pieces exist; durable host closure remains:** source built (`2026-10-25-w-messaging-r2`, `2026-10-27-r3-messaging-wiring`, `2026-10-28-vn-a2d-mail-messaging`), post-checked, uncommitted wave work, untested. Finish server sends, dispatch-time consent-authorized delivery and raw webhook ingress/identity resolution; source support is not an exercised workflow.
  - **Email: REUSE Jini.** Make resend-email and amazon-ses adapter modules for `@jini-ai/platform/mail` (rc.2 installed with `createMailAdapterContext`; provider construction is the in-flight `w15-a3-mail` job), the way Tovu's resend plugin does (`tovu-mail-adapters.json`). It provides the provider registry, purpose-scoped mailer, delivery policy with one-click unsubscribe, rate limits, feedback ingest with suppression, and sender-domain verification. Also use `@jini-ai/platform` aws-sigv4 for SES and `@jini-ai/integrations/webhooks`. Descriptor-only work is done (`w7-a2d-mail`); A3-mail + A2d-mail + A7 part 2 own the remaining host mail port.
  - **SMS/WhatsApp:** stay plugin-only; no published Jini messaging-engine adoption is established. Localized WhatsApp opt-outs still need authoritative vocabulary; retain preference-event withdrawal support.
- [ ] **Official brand logos — DEFERRED by owner 2026-10-28:** keep neutral monograms. Future approved kits must follow each vendor's brand guidelines; put files in `<plugin>/io.github.ainsep.openmarketing/assets/` (manifest-declared, digested), with the guideline URL per file. Google's official button kit is the clean route.
- [x] **Agent Plugins standard:** DONE 2026-10-25 (b5). Every `$schema` is now the published 1.0.0 (1.1.0 returns 404). This covers portable.ts, fixtures, server and tests. `@open-marketing/plugins` typecheck is green; tests not run. The architecture reports still say 1.1.0.
- [ ] **Lint/complexity sweep — scoped fixes built; final gate open:** `2026-10-28-w3-gates-{charts,plugins-a,plugins-b}`, `w3-measure-parse`, `w5-plugin-gates`, hot server/studio and cleanup jobs have post-checks; wave source is uncommitted and untested. Historical CX1 counts are obsolete. After dependencies/dist rebuilds, ONE integration-pass lint + typechecks → ONE gate/docs job (items above). Keep cognitive >10, nesting >3 and signature violations as errors; embedded snippet JS remains a coverage blind spot. Cyclomatic/NLOC stay report-only.
- [ ] **Test quality — audit DONE; execution BLOCKED on cloud:** `ADS-memory/reports/2026-10-25-test-quality-audit.md`, using `codex-runs/2026-10-24-test-quality/tovu-test-guidance.md`. Selected assertion/fixture trims and upload regressions are written (`2026-10-28-oe-test-trims`, `w2-upload-boundary-tests`), post-checked, uncommitted, untested. Apply remaining selected findings, measure actual executed counts/coverage and Stryker in cloud. The stopped 10-27 test-gap analysis produced no report; don't count it as complete.
- [ ] **T1 full test pass — BLOCKED on integration → commit → push → ONE cloud test** (owner-approved for the end), then fixes; never run tests on this machine.
- [ ] **P2 .dmg build:** Node 24.2.0 tarball + fresh builds, after everything above.
