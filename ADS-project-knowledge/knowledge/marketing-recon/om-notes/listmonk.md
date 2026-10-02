# Open Marketing — notes on this clone

This repo was surveyed for the Open Marketing build. **This file is ours, not upstream's** —
it is untracked here and safe to delete.

- **Doc:** `../docs/listmonk-architecture.md`
- **Read first:** `../docs/capability-synthesis.md` (organized by capability, supersedes the
  per-repo docs for decision-making)
- **Plan:** `../docs/open-marketing-build-plan.md`
- **cbm index:** `listmonk` — already built, do **not** re-index

## Licence — IDEAS ONLY · except the MIT email builder

**AGPLv3 for the entire main tree** — Go backend, Vue admin, SQL, everything. The network-use
clause triggers on offering a derivative as a hosted service.

**`frontend/email-builder/` is separately MIT** (Waypoint/Metaccountant Inc. 2024) and is
takeable — but pull it from upstream `usewaypoint/email-builder-js` rather than out of this
fork, for clean provenance.

*Engineering reading of licence text, not legal advice.*

## What this repo was mined for

The closest architectural analogue to the planned design (Postgres, poller, no queue broker) —
and the cautionary tale: it has **zero Go tests across 94 files**, which is what happens when a
long-running engine has no injectable clock.

Also a counter-example on deliverability: two global throttles and **no notion of a recipient
domain**, so no per-domain reputation and no warm-up.
