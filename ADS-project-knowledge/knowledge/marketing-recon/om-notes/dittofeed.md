# Open Marketing — notes on this clone

This repo was surveyed for the Open Marketing build. **This file is ours, not upstream's** —
it is untracked here and safe to delete.

- **Doc:** `../docs/dittofeed-architecture.md` + `../docs/dittofeed-sitemap.md`
- **Read first:** `../docs/capability-synthesis.md` (organized by capability, supersedes the
  per-repo docs for decision-making)
- **Plan:** `../docs/open-marketing-build-plan.md`
- **cbm index:** `dittofeed` — already built, do **not** re-index

## Licence — YES for everything present

MIT throughout. But `packages/ee/` is referenced by `docker-compose.ee.yaml:24` and is
**absent from the tree** (0 tracked files) — do not assume the OSS build is feature-complete.

*Engineering reading of licence text, not legal advice.*

## What this repo was mined for

**The journey node taxonomy — take the design, not the substrate.** Dittofeed runs one
Temporal workflow per user per journey; the plan replaces that with a `journey_run` table plus
a Postgres poller. Its `RateLimitNode` is an unimplemented stub (verified).

Also the segment-definition versioning that earns a free recompute — the one place any surveyed
repo solved incremental recompute cleanly.

⚠️ Early doc; contains unwanted architecture-metric material. Ignore that section.
