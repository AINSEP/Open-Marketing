# Open Marketing architecture debate: P0 → P2 (P3/P4 outline), 2026-10-25

**Format:** Swarm Consensus debate, 2 rounds.
- **Voting participants:**
  - Claude Opus 5.5, as a subagent;
  - Codex GPT-6.1 Sol, high reasoning;
  - Gemini 4 Argon, high (agy).
- **Coordinator:** open-marketing-b5. It framed the packets, relayed every participant's full reasoning, and **did not vote**.
- **Inputs:** packet `CTX-om-arch-2026-10-25`, covering:
  - roadmap, COMMON.md and owner decisions;
  - the five-repo gap synthesis plus the Codex gap review and blind verdicts;
  - the 12 over-engineering audits;
  - the Jini 0.6.15 changes;
  - a Jini capability excerpt.
- **Raw answers:** `ADS-memory/.local-artifacts/swarm-consensus/runs/om-arch-2026-10-25/{r1,r2}/{opus,codex,gemini}.md`. Round 2 gave each participant the other two's full round-1 answers plus a 10-point ballot.

**Owner direction given during the debate (binding on the synthesis):** put as much as possible in **skills, plugins and agent plugins**, for swappability. Core feature slices keep only contracts, safety/approval, durable state and orchestration.

## Decision ledger (final round-2 votes)

| # | Question | Opus 5.5 | Codex 6.1 Sol | Gemini 4 Argon | Result |
|---|---|---|---|---|---|
| D1 | Reporting home | new `performance` slice (delete measure's ~100 lines of reporting, which has no production writer) | extend `measure` with an explicit internal reporting boundary | extend `measure` | **2–1 extend `measure`.** **Owner decision** (the 10-24 debate split 2–2). If "measure": add a lint rule that reporting never imports delivery and imports no policy gates; reporting gets lead stats through a caller-owned port. |
| D2 | Lead inbox | `leads` slice (+ frozen last-touch per lead) | `leads` slice | `leads` (changed from contacts) | **3–0: small `leads` slice.** A lead is an enquiry; a contact is an identity. Lead intake must succeed regardless of permission to share conversions. |
| D3 | Brand kit | small `brand` slice (changed: Jini settings has a global coercer registry, no SQL repo, no draft/confirmed) | small `brand` slice (`cms/settings` is a deprecated re-export that needs a host adapter) | Jini `cms/settings`, no slice (changed) | **2–1: small P2 `brand` slice** (two tables: revisions + current projection; draft → confirmed). Jini settings holds only scalar preferences and business goals. |
| D4 | Alerts | server module (changed) + self-re-enqueuing outbox job | `alerts` slice (changed) + recurring outbox job | server module + self-re-enqueuing job | **2–1: server module; 3–0 on a recurring jobs-outbox evaluation** (no scheduler service, no notification framework). Email is a separate typed job under a bounded approved notification definition. |
| D5 | Plugin capabilities | one catalog + minimum effect floor + one plugin ABI + one server invoker; delete hard-coded `pluginIds` (`agent-plugin-backends.ts:41`) | agree; floors are required effect **sets**, not one ordered scale | agree | **3–0.** Discovery ≠ production admission. Neither plugins nor callers can lower effects. |
| D6 | Launch v2 | replace v1; old rows return typed `legacy_launch_version` → "re-create" | v2-only for new execution; keep a bounded v1 **historical decoder** for display/audit/reconciliation | replace v1 outright | **3–0 v2-only for new execution; 2–1 against keeping a v1 decoder.** Never invent missing destination URLs. **Owner check:** confirm no v1 records worth keeping (Codex's caveat). |
| D7 | Campaign join | `CampaignKey {pluginId, accountId, vendorCampaignId}` via vendor URL macros, stored as `ck1:` in the existing `web_touch.campaign_id` (no migration); counted only if the campaign appears in the account's metric rows; the plugin fills the ID for vendors without macros | adopt; URL params are visitor-controlled claims, so resolve against admitted accounts + the observed campaign catalog; unmatched = unattributed; keep deployment references for reconciliation | adopt | **3–0** with all refinements. |
| D8 | Scheduled jobs / caps | OM jobs `available_at`; caps premature; Jini outbox needs an additive `availableAt` before OM swaps | same; note `enqueue` currently forces `availableAt = now`, so add bounded due-time input | same (changed from Jini) | **3–0:** expose due time through the existing jobs boundary; defer per-vendor caps until throughput needs them. |
| D9 | Consent/erasure barrier | pure `policy.dispatchDecision` inside dispatch-start tx; erasure = suppression + cancel queued jobs atomically; **per-subject lane** held through the vendor call | agree, but a tx alone doesn't stop a send that starts after withdrawal commits; one injected server serialization protocol shared by dispatch/withdrawal/erasure/merge, held through the bounded provider attempt without holding SQLite open | agree, incl. merge-lineage handling | **3–0** with the subject-lane amendment. Guarantee: no send STARTS after a withdrawal commits; sends already in flight go through reconciliation. |
| D10 | Metrics contract | 5 base metrics (spend, impressions, clicks, vendorConversions, vendorConversionValue); no reach; integer micros | 6 (+ reach, non-additive); bounded decimal minor units | 7 (+ reach, frequency) | **3–0 on structure:** ratios always computed in code; "unsupported" (absent from the plugin's declaration) vs "unavailable" (`null`) vs zero kept distinct; account currency, no FX. **Split on reach and on units.** |

### Coordinator notes on the open splits (non-voting; the facts each side relied on)
- **D1:** both sides agree reporting and delivery must stay separable, and that extraction later is mechanical if `measure`'s internal boundary is enforced. The 2–1 majority cited existing ownership and less migration work. The minority cited that measure's current reporting is small and has no production writer, so it would be cheap to move now.
- **D10 reach:** reach can't be summed across days. Including it needs a per-cohort/period-only rule (Codex); Opus excludes it. A middle path: keep the base set at 5 additive metrics and make `reach` an optional period-grain series a plugin may declare.
- **D10 units:** integer micros (Opus) vs bounded decimal minor units (Codex). Both avoid floats; choose one in P0-1.

## Converged architecture (all three, round 2)
- **Contracts (pure, `packages/contracts`):**
  - `report.metrics.v1`: per-day rows at account/campaign/ad-group/ad grain, support declaration per grain, completeness/freshness/restatement flags, account timezone;
  - the capability catalog with effect floors;
  - `CampaignKey`;
  - NeutralCampaignLaunch v2: lead/sales objectives, postal/radius targeting, per-ad destination URL;
  - `ApproverRef` (actor identity);
  - the `DispatchDecision` barrier.

  Plugin-facing schemas live here, because plugins may only import contracts.
- **Slices:**
  - existing: `measure` (reporting + attribution + delivery, separated internally); `campaigns` (launch v2, pre-flight, card binding); `policy` (`dispatchDecision`); `safety` (ApproverRef, `mayAnswer`); `privacy` (erasure transaction); `jobs` (due time);
  - **new:** `leads` (P1) and `brand` (P2).
- **Server:** one manifest-driven `invokeCapability` replaces the hard-coded plugin list. Also: the `alerts` module, the subject-lane serialization protocol, and Results/Leads/Tracking/Brand through HTTP + studio + CLI + MCP.
- **Agent plugins (vendor code only):**
  - `report.metrics.v1`, `campaign.status.v1`, `tracking.tag.v1` (P1, Google + Meta first);
  - `campaign.validate.v1` dry run (P2; mandatory only where the vendor offers one, and "vendor-validated" is shown only after a real dry run);
  - the remaining 14 ad plugins in 3–4-plugin runs.
- **Skills (om-playbook):** ad-copy variants, plus later optimisation, fatigue and A/B method. Deterministic limits, sample sizes and thresholds are code.
- **Pre-flight:** OM's own checks (destination readiness, tracking installed, conversion setup) plus the vendor dry run on the exact translated plan. Any blocker means no card; the pre-flight digest is bound into the exact card.
- **Lead journey:**
  1. The tracking snippet and vendor URL macros carry a `CampaignKey`.
  2. Lead intake (form, call, booking or manual) happens in `leads`.
  3. Stage changes are recorded with a frozen 30-day last-touch attribution; an unknown or forged key counts as unattributed.
  4. Cohort rules: leads are counted by the period they were created in; "cost per verified lead" is labelled apart from customer CAC.
- **Gate:** no Results UI ships before the read-only real-account check passes (Google + Meta per-campaign spend within ±1%, and a test lead resolves to the right `CampaignKey`).
- **Following the owner's skills/plugins direction:**
  - brand extraction from a URL is an optional agent plugin that only pre-fills drafts;
  - Google Business Profile and organic publishing are agent plugins in P4 (P0 reserves the capability ID only);
  - analytics and error providers are plugins via Jini's pending observability/analytics ports.

## Migrations (proposed; one integrator; next free v23)
Opus/Gemini order:
- v23: reporting tables (in `measure` if D1 = measure);
- v24: `leads`;
- v25/v26: alerts (server) and web-events readiness;
- v26/v27: `brand` (P2);
- P2: drop the old sandbox snapshot table.

The integrator fixes the final numbering when P0 is approved.

## Build order (merged; each step = one Codex plan → review → build run)
1. **P0-1 contracts:** metrics, capabilities, launch v2, identity, barrier. One integrator.
2. **P0-2, in parallel:**
   - (a) `policy.dispatchDecision`;
   - (b) `safety` ApproverRef + `mayAnswer`;
   - (c) `privacy` erasure transaction + server subject lane, with red/green race/restart tests;
   - (d) `jobs` due-time input.
3. **P0-3:** file the Jini asks: user-management permission-catalog injection, outbox `availableAt`, and settings coercer injection only if still needed.
4. **P1-1:** google-ads + meta-ads: `report.metrics.v1`, `campaign.status.v1`, `tracking.tag.v1`.
5. **P1-2:** `invokeCapability` + manifest discovery; delete `pluginIds`.
6. **P1-S0 gate:** the real-account reconciliation (needs the owner's accounts and authorisation).
7. **P1-3:** reporting persistence and sync job (D1 home).
8. **P1-4:** web-events snippet, `CampaignKey` parsing, readiness.
9. **P1-5:** the `leads` slice + intake.
10. **P1-6:** alerts + owner email (resend-email under a one-time ServiceGrant) + P1 HTTP/CLI/MCP/studio closure.
11. **P2:**
    - offline conversions (qualified/won → measure when the grant is active);
    - launch v2 translation + `campaign.validate.v1` + pre-flight card binding (Google, Meta);
    - the remaining ad plugins on metrics/status;
    - **the Apple Ads Platform API v1 migration, merged by 2026-12-15** (sunset 2027-01-26);
    - the `brand` slice + `ad-copy-variants` skill;
    - the Jini 0.6.15 outbox cutover once it's published (OM's SQLite adapter must pass `fencedOutboxConformance`).
12. **P3/P4 (outline):**
    - optimisation rule packs → findings → exact cards (Google search-term report + negative keywords first);
    - A/B testing and fatigue, with the math in code and the method in skills;
    - the GBP plugin + organic publish contract;
    - per-vendor concurrency only when needed.

## Owner questions (participants' recommended defaults)
1. **D1: reporting in `measure` (majority) or `performance` (Opus)?** Default: `measure`, with the lint boundary.
2. **D10 reach:** exclude it, or allow it as an optional period-only series? Units: micros or decimal minor units?
3. **D6:** confirm no v1 launch records need to stay readable (default: typed legacy error, "re-create").
4. **Pacing alert default:** month-to-date above 110% of elapsed budget, or today above 2× the daily budget.
5. **Lookback:** 30-day last touch; an unknown or forged key counts as unattributed.
6. **Alert email:** resend-email under a one-time ServiceGrant, capped at 20/day, with in-app alerts always on.
7. **Agent-initiated lead stage changes:** generic exact card; the owner's own studio changes apply directly.
8. **Spam after a conversion was shared:** OM-side retraction only in P2; vendor retraction in P3.
9. **Existing campaigns without URL macros:** the Tracking page proposes template updates through an exact card.
10. **Jini user-management not yet instance-injectable:** fall back to a `local_token` ApproverRef.

## Round 3: final ballot (Opus 5.5 / Codex 6.1 Sol / Gemini 4 Argon)
Raw votes: `runs/om-arch-2026-10-25/r3/{opus,codex,gemini}.md`.

| Item | Opus | Codex | Gemini | Result |
|---|---|---|---|---|
| S1 reporting | measure (switched from performance) | measure | measure | **3–0: extend `measure`** with enforced lint separation (reporting never imports delivery, identifier ingestion or policy gates) |
| S2 brand | brand slice | brand slice | brand slice (switched) | **3–0: small P2 `brand` slice** |
| S3 alerts | server module | server module | server module | **3–0: server module + recurring jobs-outbox evaluation** |
| S4 metrics | 5; reach later (P3) as an optional period series | 5 + optional period reach | 5 + optional period reach (switched) | **3–0: 5 additive base metrics; reach only as an optional period-grain series** (now vs P3: 2–1 now) |
| S5 units | integer micros | bounded decimal minor units | integer micros (switched) | **2–1: integer micros** of account currency |
| S6 old v1 launches | typed legacy error → re-create; raw rows untouched | bounded read-only v1 decoder | typed legacy error | **2–1: typed legacy error → re-create** (raw rows kept) |
| Q4 pacing | accept + no month-to-date alert before day 3 or below a spend floor; separate lifetime-budget rule | accept, with budget-semantics/data-quality conditions | accept | **3–0 accept, with Opus's guards** |
| Q5 lookback | 30-day last PAID touch | accept | accept | **3–0** |
| Q6 email | accept | accept (versioned grant) | accept | **3–0** |
| Q7 agent stage changes | accept; one card may list several named leads | accept | accept | **3–0** |
| Q8 spam after sharing | accept (Meta has no retraction API, so P3 is mainly Google) | accept | accept | **3–0** |
| Q9 missing macros | accept; prefer account/campaign-level templates; warn that Meta ad edits trigger review | accept | accept | **3–0** |
| Q10 identity fallback | local_token bound to the owner's device, never issuable to the agent | accept, separate from agent credentials | accept | **3–0** |
