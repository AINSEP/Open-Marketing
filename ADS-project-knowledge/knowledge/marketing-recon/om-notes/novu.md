# Open Marketing — notes on this clone

This repo was surveyed for the Open Marketing build. **This file is ours, not upstream's** —
it is untracked here and safe to delete.

- **Doc:** `../docs/novu-architecture.md`
- **Read first:** `../docs/capability-synthesis.md` (organized by capability, supersedes the
  per-repo docs for decision-making)
- **Plan:** `../docs/open-marketing-build-plan.md`
- **cbm index:** `novu` — already built, do **not** re-index

## Licence — MIT tree YES · enterprise NOT PRESENT

MIT (`LICENSE-MIT`) for all of `apps/`, `libs/`, `packages/`. Novu Proprietary Licence for
`enterprise/packages` — which is an **uninitialized git submodule** pointing at private
`novuhq/packages-enterprise`; local `src` entries are dangling symlinks into an empty
`.source/`. There is nothing there to copy or evaluate.

*Engineering reading of licence text, not legal advice.*

## What this repo was mined for

Preference merging. Its five-tier model is the right shape to *grow into* and the wrong thing
to start with — the plan ships a single boolean per `(subject, group)` first.

Its in-app inbox is built for an embeddable third-party widget and is deliberately deferred; a
REST poll gets most of the value.
