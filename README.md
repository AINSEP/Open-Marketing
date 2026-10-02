# Open Marketing

Preserve-only skeleton for an agent-native marketing application. It has four independently built application shells and twelve feature packages. Domain services explicitly return `not_implemented`; vendor plugins are disabled skeletons. This repository does not provide production marketing behavior yet.

Start with [START-HERE.md](START-HERE.md), [engineering rules](development/COMMON.md), [feature jobs](development/JOBS.md), and the [accepted v2 architecture](ADS-memory/reports/2026-10-01-om-target-architecture-v2.md).

Node 24.2.0, Corepack and pnpm 10.24.0 are pinned. Install using `corepack pnpm install`, then run `corepack pnpm om:check`. Package tests/builds remain package-scoped.

No vendor APIs, spend or live migrations are part of this skeleton. Migration history is preserved; its prior application status is unresolved.
