# OSS marketing survey — docs

Recon of open-source marketing tooling, surveyed 2026-09-06. The clones these
docs describe are the sibling directories of this folder.

**Read first: [`capability-synthesis.md`](capability-synthesis.md).** It is
organized by capability rather than by repo — journeys, segmentation,
incremental recompute, sending, deliverability, templating, consent/compliance,
identity, ingestion, webhooks — then a licensing table, a build order, and a
"what nobody solved well" section. It supersedes the per-repo docs for
decision-making; read those for the detail behind a specific claim.

## Per-repo docs

| Doc | Clone |
| --- | --- |
| `chatwoot-architecture.md` (+ `chatwoot-sitemap.md`) | `../chatwoot` |
| `dittofeed-architecture.md` (+ `dittofeed-sitemap.md`) | `../dittofeed` |
| `formbricks-architecture.md` | `../formbricks` |
| `inngest-architecture.md` | `../inngest` |
| `jitsu-architecture.md` | `../jitsu` |
| `listmonk-architecture.md` | `../listmonk` |
| `matomo-architecture.md` | `../matomo` |
| `mautic-architecture.md` | see caveat below — not in this folder |
| `novu-architecture.md` | `../novu` |
| `rudder-server-architecture.md` | `../rudder-server` |
| `trigger-dev-architecture.md` | `../trigger.dev` |
| `unomi-architecture.md` | `../unomi` |

## Caveats

- **Licensing is the binding constraint, not code quality.** Seven distinct
  patterns across these repos. The synthesis has a per-repo table naming which
  sources code may be taken from and which are ideas-only. Do not lift code
  without reading it.
- **Mautic has no clone here.** It lives inside the Open Marketing product repo
  at `/Users/la/Programming/delete-later/Open-Marketing-bare/integrations/mautic`
  (313 MB) — a directory named `delete-later`. `mautic-architecture.md` cites an
  older path that no longer resolves. If Mautic's segment query builder matters
  to the build, move it somewhere safe first.
- **`mautic-architecture.md` here is a copy.** The original is tracked in the
  Open Design fork at `/Users/la/Programming/Open-Marketing/docs/`, committed in
  `a263dde0b`. The two can drift.
- **PostHog was deliberately dropped** from the survey as product analytics
  rather than marketing automation. `../posthog` is cloned, but there is no doc
  and nothing in the synthesis is sourced from it.
- **Quality varies.** The earliest docs (chatwoot, dittofeed) carry
  architecture-metric material that is not wanted; ignore it. Several docs
  contain coordinator-added corrections marked as such — those are authoritative
  over the surrounding text.

## Machine safety

Running several concurrent codebase indexers drove this machine into severe
memory pressure during the survey. Two specific traps:

- `TaskStop` does **not** kill a codebase-memory-mcp index worker. It reports
  success while the worker keeps allocating, and one was seen respawning under a
  new PID. Kill the PID directly and verify.
- cbm holds the whole graph in memory and writes only at the end, so a large
  repo gives no partial output and no early warning — one worker reached 3.3 GB
  in two minutes.

cbm indexes already built and reusable (no re-indexing needed): chatwoot,
dittofeed, listmonk, unomi, jitsu, formbricks, rudder-server, trigger-dev, novu,
inngest, matomo.
