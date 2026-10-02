# Agent Entry Point — Open Marketing

Read this file first when entering the repository. Agent behavior boots from
`AI-Dev-Shop/AGENTS.md`; that is mandatory. This file adds the project-specific
map and rules.

## What this repo is

Open Marketing (OM) is an open-source marketing app: AI creative production
(Higgsfield and other vendors), ad campaigns (Google Search and Meta first), and
measurement (tracked links, server-side conversions, CAC). Vendor integrations
are Agent Plugins (agent-plugins.org spec v1.1.0). Shared infrastructure comes
only from published `@jini-ai/*` packages. Code may be copied from Tovu, but OM
never imports Tovu.

The repository was cleared of its Open Design ancestry on 2026-10-01. The old
code lives in git history (commit `9d343ab68` and earlier) and in the upstream
`origin` remote (`nexu-io/open-design`). Do not restore it.

## Where things are

- **Target architecture (read first):**
  `ADS-project-knowledge/reports/2026-10-01-om-target-architecture-v2.md`
  (v1 alongside it is superseded).
- **Marketing research:** `ADS-project-knowledge/knowledge/marketing-recon/`.
  Start with `capability-synthesis.md`, then `open-marketing-build-plan.md`. It
  holds 13 per-repo deep dives, the five architect reviews and each repo's notes.
- **Preserved OM work, awaiting relocation by the skeleton job:**
  `packages/{spine,om-clock,om-outbox,om-pg,segments,render}`,
  `apps/web/src/components/om-chat/`, `apps/daemon/src/tools-app-control-cli.ts`.

## Target shape (summary; the architecture doc is authoritative)

- `apps/studio`: operator UI. Features on the left, canvas in the center, AI
  chat on the right.
- `apps/desktop`: Electron shell hosting studio.
- `apps/server`: API, database, workers, plugin/MCP federation host,
  credentials, safety.
- `apps/agent`: agent runtime as a separate process. It talks only to the
  server's OM tool surface.
- `features/<name>/`: feature modules imported by package name only.
- `packages/contracts`: shared DTOs.
- `content/agent-plugins/`: vendor plugins.

## Engineering rules

Every design or implementation brief restates the owner's full rule set: see the
"OM engineering contract" (COMMON.md block) in the architecture doc, and
`AI-Dev-Shop/framework/templates/bootstrap/starter-conventions-typescript.md`.
In short: feature slices with `index.ts` as the only public API; modular and
reversible first; dependency injection via ports; `fn(requiredArgs,
optionalArgs?)`; cognitive complexity ≤10 and nesting ≤3; no functions in .tsx
component bodies; one general approval rule for external tools; self-contained
plugins.

## Git

- Commit only Open Marketing work. Don't add co-author trailers.
