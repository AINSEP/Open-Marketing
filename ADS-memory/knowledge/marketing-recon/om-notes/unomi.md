# Open Marketing — notes on this clone

This repo was surveyed for the Open Marketing build. **This file is ours, not upstream's** —
it is untracked here and safe to delete.

- **Doc:** `../docs/unomi-architecture.md`
- **Read first:** `../docs/capability-synthesis.md` (organized by capability, supersedes the
  per-repo docs for decision-making)
- **Plan:** `../docs/open-marketing-build-plan.md`
- **cbm index:** `unomi` — already built, do **not** re-index

## Licence — Apache-2.0 — but ideas only in practice

Apache-2.0 throughout. Root `license-mappings.xml` declares third-party licences for release
compliance only and gates nothing.

The licence permits lifting; the **language does not** — it is Java/OSGi, so nothing is liftable
into a TypeScript/Postgres build. Ideas only by circumstance, not by licence.

*Engineering reading of licence text, not legal advice.*

## What this repo was mined for

Profile and segment modelling — the identity/consent side of the spine.
