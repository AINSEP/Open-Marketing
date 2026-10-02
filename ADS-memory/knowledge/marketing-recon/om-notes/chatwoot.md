# Open Marketing — notes on this clone

This repo was surveyed for the Open Marketing build. **This file is ours, not upstream's** —
it is untracked here and safe to delete.

- **Doc:** `../docs/chatwoot-architecture.md` + `../docs/chatwoot-sitemap.md`
- **Read first:** `../docs/capability-synthesis.md` (organized by capability, supersedes the
  per-repo docs for decision-making)
- **Plan:** `../docs/open-marketing-build-plan.md`
- **cbm index:** `chatwoot` — already built, do **not** re-index

## Licence — MIT tier YES · enterprise/ NO

MIT Expat for `app/` and `lib/` — take freely. **Chatwoot Enterprise Licence** for
`enterprise/` (320 `.rb`, 16,783 LOC): production use needs a paid seat subscription and
modifications assign back to Chatwoot.

Note the seam is **not** runtime-gated: `ChatwootApp.enterprise?` merely checks the directory
exists (`lib/chatwoot_app.rb:14-18`) and `enterprise/app/**` is unconditionally eager-loaded
(`config/application.rb:43-46`). "Not portable" here is a legal statement, not an architectural one.

*Engineering reading of licence text, not legal advice.*

## What this repo was mined for

The drops layer and channel abstraction (both MIT, both takeable). Counter-example on
delivery: it has no per-recipient ledger, so it permanently cannot answer "what did we send
this person, and did it arrive."

⚠️ This was one of the two earliest docs written and carries architecture-metric material
that is **not wanted** — ignore that section.
