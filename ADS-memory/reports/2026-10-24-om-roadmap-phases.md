# Open Marketing roadmap — Phases 0–4 (2026-10-24)

Source: a two-round design debate between Claude Opus 5.5, Claude Sonnet 5.5, GPT-6.1 Sol (Codex) and Gemini 4 Argon, merged by the coordinator. Full report: `ADS-memory/.local-artifacts/swarm-consensus/runs/2026-10-24-om-marketing-gaps-consensus-report.md`. Individual answers are in `.../om-gaps-2026-10-24/{r1,r2}/`.

Binding engineering rules for every phase:
- modular feature slices (index.ts is the only public API), no coupling, dependency injection for all I/O;
- vendor code only in its agent plugin;
- fn(required, optional?) arguments, cognitive complexity ≤10, nesting ≤3;
- library-first and rule-of-two; reuse Jini 0.6.12 packages, and fix gaps upstream in Jini;
- ONE approval policy (exact card for every ad-spend call), consent rechecked at dispatch.

## Phase 0 — Contracts (a few days, one integrator job)
- Actor/approver contract: who may answer an approval card, and who approved what in the audit log.
- `report.metrics.v1`: a shared per-day metric shape (MetricObservation) at account, campaign, ad-group and ad grain, with completeness flags. **Urgent:** the 12 new ad plugins currently report only account spend.
- Neutral capability IDs that plugins implement.
- NeutralCampaignLaunch v2: leads/sales objectives, postal-code and radius targeting, a per-ad destination URL. Today it is traffic plus country only.
- A consent/erasure-vs-dispatch barrier, so nothing is sent after withdrawal.
- Upstream Jini request: `@jini-ai/user-management`'s permission catalog is a module singleton; make it instance-injected.

## Phase 1 — "Know if my ads work": the closed lead journey (Google + Meta first)
- Tracking setup: the OM snippet loads Meta Pixel and Google tag; UTM policy.
- Destination readiness check. A business without a site uses the existing hosted form page.
- Form lead → lead inbox with stages (new / qualified / won / disqualified / spam).
- Per-campaign results: vendor spend, clicks and impressions next to OM-verified leads.
- Three alerts, in-app and by email: approval waiting, ad disapproved, overspend/pacing.
- Jini owner identity recorded on approvals.
- Attribution: one declared last-touch model plus an "unattributed" bucket. Vendor-reported numbers are shown separately and never summed.
- De-risk before coding: a 1–2 day read-only check on one real Google account and one real Meta account. Per-campaign spend must match the vendor dashboards within ~1%, and a test lead must land on the right campaign.

## Phase 2 — "Launch better and close the loop"
- Qualified/won leads sent back to the ad platforms as offline conversions.
- Leads/sales objectives and local targeting in launches.
- Pre-flight checks (vendor `validate_only`) before the approval card.
- Brand kit (logo, colours, fonts, voice) and product catalog feeding creative.
- All 16 ad plugins reporting on `report.metrics.v1`.

## Phase 3 — "Optimise and scale"
- Optimisation proposals as exact approval cards: creative fatigue, pacing, budget shifts.
- A/B tests.
- Landing pages through a Tovu handoff plugin. OM builds no page builder.
- CRM sync (HubSpot/webhooks).
- Weekly client report.
- Teams and agency workspaces: full Jini user-management adoption.

## Phase 4 — "Grow beyond paid ads"
- Audiences: hashed customer lists, lookalikes, retargeting (consent-aware).
- Messaging journeys over the Resend, Twilio, WhatsApp and Amazon SES plugins: segments, templates, sendability.
- Organic social and Google Business Profile publishing.
- Multi-touch attribution, only if touch data warrants it.

## Open owner decision
Where vendor metrics live, split 2–2:
- **Option A:** a new `performance` slice (Opus, Sonnet). This keeps the policy-gate-privileged `measure` small.
- **Option B:** extend `measure` with an internal reporting module (Codex, Gemini). Snapshots, attribution and CAC already live there.

Either option must keep reporting separate from conversion delivery and must not widen the policy-gate import surface.
