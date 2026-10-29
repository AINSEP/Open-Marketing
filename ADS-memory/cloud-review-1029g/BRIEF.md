# OM cloud review 1029g — batched TRIM review of 3 Codex plans (review only)

You are ONE reviewer (Sonnet; no subagents needed — at most 1). Review all three plans in one pass and write one `review.md` per job folder here: `ADS-memory/cloud-review-1029g/<job>/review.md`. Do not edit anything else.

## Method
Follow `ADS-memory/cloud-round-1029/trim-brief-1028.md` (scope, reuse, correctness, no hard-coded vendors, bug is real, size ≤90 min, lane, NO test runs in the build) with the additions in `trim-prompt-w22.md` here (Jini truth: published rc.2 in node_modules only; DUPLICATES section; LOCKS-FILES line with lock groups from `w22-lock-groups.md` in its order). Shared rules: `ADS-memory/cloud-round-1029/ctx-wave-1029.md`, `development/COMMON.md`. Inputs: each folder's `job.md` + `plan.md`; the measurements in `ADS-memory/cloud-round-1029e/HEALTH.md` and `out/cycles.json`.

## Extra checks for these refactor jobs
- **Behaviour-identical:** cut anything that changes logic, exported names, tool IDs, routes, error text or fingerprints beyond what the plan proves necessary.
- **Real cycles only:** confirm each cycle the plan targets exists in `out/cycles.json`; cut work on type-only cycles unless free.
- **Cross-job file overlap:** list any file two of the three plans both edit, and assign it to one job.
- **Concurrent cloud round 1029f** (branch `cloud/om-round-1029f`, may still be running) edits `apps/server/src/composition/agent-plugin-backends.ts`, `apps/server/src/runs.ts`, packages/om-db (SQLite pool), tiktok-ads `adapter.ts`, several plugin tests. The builds run AFTER 1029f is merged; flag plan steps that would conflict and tell the build to re-read those files first.
- **Fingerprints:** for plugin files hashed in plugin.json/capabilities.json/evidence, require exact recompute steps or cut the edit.
- Size: each build must fit ≤90 min; if not, keep the runtime-cycle core and DEFER the rest.

## Output
Branch `cloud/om-review-1029g` from `main`; commit only the three review.md files (explicit paths, no co-author trailers); push; never push to main. Stop by 25 min.
