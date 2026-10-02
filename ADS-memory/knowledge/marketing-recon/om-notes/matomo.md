# Open Marketing — notes on this clone

This repo was surveyed for the Open Marketing build. **This file is ours, not upstream's** —
it is untracked here and safe to delete.

- **Doc:** `../docs/matomo-architecture.md`
- **Read first:** `../docs/capability-synthesis.md` (organized by capability, supersedes the
  per-repo docs for decision-making)
- **Plan:** `../docs/open-marketing-build-plan.md`
- **cbm index:** `matomo` — already built, do **not** re-index

## Licence — IDEAS ONLY

**GPL-3.0+** (`composer.json:12`; `LICENSE` is GPLv3 text). Premium plugins are fetched from an
external marketplace and none of their source is in-tree. Copyleft triggers on distribution,
not network use — but moot, since we ship no PHP.

*Engineering reading of licence text, not legal advice.*

## What this repo was mined for

**The best aggregation model in the survey** — and the source of the erasure design in the
plan: deletion as a *caller of invalidation*, which is the mechanism the plan extends outward to
ad-platform deletion.

It does not send anything, so it is aggregation-side only.
