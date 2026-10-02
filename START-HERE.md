# Start here

1. Use Node 24.2.0 and Corepack with pinned pnpm 10.24.0.
2. Run `corepack pnpm install` to establish workspace links.
3. Run `corepack pnpm om:check` for lint, boundaries, all active typechecks, gate conformance, and metric integrity.
4. Run `corepack pnpm --filter @open-marketing/<name> test` and `build` for an owned package. `corepack pnpm -r build` proves independent builds.
5. Run `corepack pnpm om:dev` for the studio and independently supervised local service shells. Service shells remain unavailable for domain work.

`om:package` and `om:serve` deliberately fail with not_implemented. j23 owns packaging/production launch; they do not imply runnable production deployment.

Local services require authentication even on loopback. Service-control credentials and scoped run grants are separate. The agent receives no vendor configuration/credential, product DB access or shell capability. j22 owns verified Jini adoption and process integration.

Metric output is `.tmp/om-metrics.json`. Cyclomatic and NLOC values never gate on magnitude. Parked source is still linted. AI-Dev-Shop is separately governed; output/dependency directories are checked for provenance.

On a restricted filesystem, set `COREPACK_HOME`, `electron_config_cache`, and `XDG_CACHE_HOME` to writable cache locations. These environment variables affect installation only.
