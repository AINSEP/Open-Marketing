# Open Marketing — notes on this clone

This repo was surveyed for the Open Marketing build. **This file is ours, not upstream's** —
it is untracked here and safe to delete.

- **Doc:** `../docs/inngest-architecture.md`
- **Read first:** `../docs/capability-synthesis.md` (organized by capability, supersedes the
  per-repo docs for decision-making)
- **Plan:** `../docs/open-marketing-build-plan.md`
- **cbm index:** `inngest` — already built, do **not** re-index

## Licence — IDEAS ONLY (today)

**SSPL v1** for the whole repository, plus a **Grant of Future License**: every line
automatically relicenses to **Apache-2.0 on the third anniversary of the date it was made
available** (`LICENSE.md:561-579`). Nothing in-tree marks which lines have crossed over, and
`git blame` archaeology is not worth doing.

SSPL §13 targets offering the program's functionality as a service; it does not restrict
reading the design and reimplementing.

*Engineering reading of licence text, not legal advice.*

## What this repo was mined for

**The headline finding of the whole survey.** Inngest reduces a multi-day wait to an ordinary
queue item scored at a future timestamp — which is the proof that no durable-execution engine
(Temporal, workflow VM, process checkpointing) is needed for a finite graph of known steps.

Its multi-tenant fairness machinery (shadow partitions, DRR, GCRA) is deliberately **not**
adopted: it exists for thousands of independent tenants, and single-owner partitions cover one.
