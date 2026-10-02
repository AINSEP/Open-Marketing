# Open Marketing agent entry point

Read `AI-Dev-Shop/AGENTS.md` and the dispatched persona first. AI-Dev-Shop is a separate read-only repository.

Authoritative architecture: `ADS-memory/reports/2026-10-01-om-target-architecture-v2.md`.
Engineering contract: `development/COMMON.md` (repeat unchanged in every job brief).
Feature job ownership and commands: `development/JOBS.md`.

Prefer codebase-memory-mcp search_graph/trace_path/get_code_snippet/query_graph/get_architecture for code discovery. Refresh the index when needed; use direct source discovery when unavailable or insufficient. Strings/config/docs may use rg.

Four inert applications: studio (React/Vite), desktop (Electron host port), server (HTTP/DB/workers/plugin composition), agent (separate runtime port).
Features import only public `@open-marketing/<name>` packages; caller-owned ports adapt cross-feature needs. Only safety/measure may import policy pure gates. Contracts stay pure. Vendor implementation and configuration live in `content/agent-plugins`. Parked source is linted and stays outside runtime/workspaces.

Run `corepack pnpm om:check` and package-scoped test/build/typecheck. No inherited application commands, old UI, vendor spend, or live migrations. Imports/factories do not start services.
Preserve dirty/untracked work. Never edit another active job's files. Shared contracts/manifests/lockfile/composition have one integrator. Report NEEDS for collisions.
Commit only OM work when instructed; no co-author trailers. j00 is not authorized to commit or push.
