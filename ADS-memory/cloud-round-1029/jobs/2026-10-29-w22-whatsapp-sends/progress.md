# W22 WhatsApp sends — B1 progress

Programmer(Direct), 2026-10-29. Binding scope: plan.md amended by review.md and its Coordinator override. No previous progress record. Preserve pre-existing dirty/untracked files. No tests/builds/installs/om:check; one plugin typecheck at the end. Server is outside scope.

## Pre-code decisions

- DONE: loaded Programmer persona and binding review; verified existing broadcast export cannot serve the host's sendMessage ABI. Host channel dispatch, policy, approval, outbox and accounting already generalize; leave them untouched.
- Reuse: existing parseCredential/readBody/templatesSchema and contracts decimalToMicros/quote schema. Twilio broadcast.ts is the approved ABI style example. Searches in published Jini 0.6.15-rc.2 dist, Tovu apps/packages and read-only ai-traces-jini source found no matching WhatsApp/pricing/prefix mechanism (only SEO text). Do not use stale Jini tree or unpublished APIs.
- Architecture checklist: vendor code remains plugin-local; public index only; dependencies and time injected; one credential access per call; strict nested input; bounded two GETs and one single-shot POST; typed redacted failures; host owns authority and dedup. No new ports or shared contract edits.
- Pattern priming: review FIX 1 explicitly approves the existing Twilio sendMessage/quote ABI as the seed; follow that reviewed pattern without another approval pause.
- Test seams: actual sendMessage + fixture fetch/credential/authority/clock; pure maximumRate with fixture rates. Adversarial cases: ambiguous template rows, longest matching prefix, unknown-prefix maximum, missing/malformed category, second execute and post-submit uncertainty. Tests written only; no red/green claim or certified suite supplied.
- Pricing evidence attempt: public Meta pricing page reachable; pricing.md inaccessible; linked rate-card page returned 429, so no CSV URL/numeric rates verified. Production rate rows will remain empty. Prefix facts explicitly recorded by the review are available; full mapping remains unverified in this run.

## Scope status

1. DONE: added src/rates.ts (partial review-evidenced prefixes, empty production USD table, longest-prefix/max-category selection via decimalToMicros). Added fixtureRates in tests/fixtures.ts and direct rate regressions in tests/broadcast.test.ts (written, not run). Full primary mapping and CSV remain unavailable; follow-up must complete mapping before populating production rows.
2. DONE: broadcast.ts exports host-compatible sendMessage/messageChannel and strict template message schema; index.ts replaces old broadcast exports. Currency and template GETs reuse readBody/templatesSchema, quote reuses shared money contracts, one credential access covers the call, execute rechecks expiry/cancellation and posts once. fixtures.ts and broadcast.test.ts migrated together; existing receipt/dedup/authority assertions retained and new template/currency/quote/digest/empty-table/secret regressions written (not run). Removed unused fixture-only webhook apply scaffolding (no caller).
3. DONE: primary-sources.json records the 2026-10-29 public pricing/SDK checks, failed pricing.md/rate-card retrieval and absent CSV/numeric rates. Partial mapping and production empty-table refusal are explicit; no live calls.
4. DONE: README.md and skills/whatsapp-business/SKILL.md describe the existing om_message_send path, exact card/message shape, approved-template-only behavior, dated list-rate upper bound, empty-rate refusal/read_only mode and explicit deferrals. Preserved unrelated webhook/marketing guidance.
5. DONE: first plugin typecheck exited 2 with two test-array inference errors; annotated arrays as schema-derived Rates[]. The one permitted corrective rerun PASSED, exit 0, no diagnostics. typecheck.txt records both outcomes. Server typecheck skipped per review/Coordinator override. Read-only scoped measureSource inspection of five touched TS files passed: source max cognitive 10/nesting 3; tests max 5/2; fixtures max 6/2. No tests/builds/installs/om:check executed. report.md records exact changed files, tests written, contracts, primary evidence, scope audit, function metrics, risks, NEEDS and handoff. Product net LOC versus pre-edit working tree: +426/-124 = +302 (source/data +106, tests +157, docs/evidence +39).

Implementation handoff complete; production activation remains PARTIAL/DEFERRED because numeric rates and the complete primary prefix map were unavailable. No follow-up item is represented as done. No product edits followed the passing typecheck.

## NEEDS / deferred

- OWNER: download Meta 'USD list rates (CSV)' (effective 2026-10-01) from developers.facebook.com/documentation/business-messaging/whatsapp/pricing into this job dir; a follow-up fills rates.ts.
- Coordinator rebuilds WhatsApp dist/digest after review. Production remains read_only.
- Full primary prefix mapping, including remaining NANP exceptions and +7 markets, must be completed before production numeric rows are added; the empty production table prevents a partial-map underquote today.
- Host intent-to-plugin gap stays deferred per review; no server edits.
