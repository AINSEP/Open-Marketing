# Open Marketing — notes on this clone

This repo was surveyed for the Open Marketing build. **This file is ours, not upstream's** —
it is untracked here and safe to delete.

- **Doc:** `../docs/jitsu-architecture.md`
- **Read first:** `../docs/capability-synthesis.md` (organized by capability, supersedes the
  per-repo docs for decision-making)
- **Plan:** `../docs/open-marketing-build-plan.md`
- **cbm index:** `jitsu` — already built, do **not** re-index

## Licence — YES — cleanest licence in the set

MIT (root `LICENSE` and `bulker/LICENSE`). Third-party list is permissive plus
unmodified-library MPL-2.0/LGPL. Enterprise billing lives in a **separate repo**
(`jitsucom/jitsu-cloud-billing`), stated once at `AGENTS.md:32-34`. Attribution only.

*Engineering reading of licence text, not legal advice.*

## What this repo was mined for

Event ingestion shape. Its Deno-worker sandbox for user-authored transforms
(`permissions: "none"` + proxied capabilities + hard timeout) is the reference design if that
is ever scoped — but it is **deliberately deferred** in the plan.

CDP profile building and warehouse fan-out are Jitsu's territory and explicitly out of scope.
