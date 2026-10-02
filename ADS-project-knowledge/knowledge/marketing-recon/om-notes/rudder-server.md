# Open Marketing — notes on this clone

This repo was surveyed for the Open Marketing build. **This file is ours, not upstream's** —
it is untracked here and safe to delete.

- **Doc:** `../docs/rudder-server-architecture.md`
- **Read first:** `../docs/capability-synthesis.md` (organized by capability, supersedes the
  per-repo docs for decision-making)
- **Plan:** `../docs/open-marketing-build-plan.md`
- **cbm index:** `rudder-server` — already built, do **not** re-index

## Licence — IDEAS ONLY — strictest in the set

**Elastic Licence 2.0** for the whole tree, `enterprise/` included — `LICENSE:1` and
`enterprise/LICENSE:1` are byte-identical. ELv2 forbids offering the software as a hosted or
managed multi-tenant service and forbids removing licence notices. **There is no permissive tier
to lift from.**

*Engineering reading of licence text, not legal advice.*

## What this repo was mined for

Ingestion and delivery-pipeline design, read only. Like Inngest, most of its sophistication is
multi-tenant fairness machinery that a single-owner deployment does not need.
