# j00 provenance

Source snapshot is recorded in development/preserve-inputs.json with original HEAD and SHA-256 for every preserved tracked source/test/config. The original untracked v2 architecture was moved intact with the knowledge directory.

| Source | Destination | Treatment / owner |
|---|---|---|
| packages/spine | features/policy | Object signatures, caller-supplied now, helper extraction; same decision ordering. j04 reviews exact authority snapshot. |
| packages/om-clock | packages/om-clock | realClock singleton replaced by createClockAdapter with injected read source; fake clock preserved. |
| packages/om-outbox | features/jobs | Characterization source is src/outbox.ts; object compatibility and helper extraction retain fencing/uncertainty. j06 builds durable adapter. |
| packages/om-pg | apps/server/src/platform/jini-compat/db | Generic machinery shim, owned object ABI; tests moved to apps/server/tests/db. j00-finish adds an inert adapter for an injected better-sqlite3 handle and portable migration/claim SQL, with real ephemeral SQLite tests. j01 replaces with a verified registry DB release and the same suite. |
| packages/om-pg/migrations/0001_spine.sql | server shim db/migrations/0001_spine.sql | Unmodified historical migration evidence, never applied by j00. Owner confirmed it was never applied anywhere and allows schema reorganization; it is not the active SQLite schema. |
| packages/segments, packages/render | development/parked | Executable source/tests kept and linted; object-signature compatibility only. Not active workspaces or runtime imports. |
| apps/web/.../om-chat | apps/studio/src/widgets/om-chat | App-global FAB/panel and structured navigation intent adapted. Original dependent implementation retained as inert .txt evidence under development/provenance/om-chat; removed UI dependency closure not restored. CSS preserved. |
| tools-app-control-cli | server src/cli/app-control.ts | HTTP-client navigation contract and target validation; honest server/browser result instead of local fake acknowledgement. Original source inert in development/provenance. |
| ADS-project-knowledge | ADS-memory | Whole-directory mechanical move; historical evidence remains historical. |

All preserved source is first-party OM work from the recorded snapshot and repository LICENSE (Apache-2.0). No sibling Tovu/Jini source was copied/imported. New skeleton source follows the same license. Legal notices are retained.

Git staging limitation: git mv was attempted and denied by sandbox .git/index.lock permissions. Filesystem moves preserve bytes. Coordinator must stage/verify renames; j00 commits/pushes nothing.

Old build configurations are retained as inert .txt evidence and replaced by newly authored OM package build commands. Temporary/generated output is not source authority.

Jini exports/releases are not assumed. The agent unavailable-runtime port is the documented removable seam: j22 adopts verified released runtime APIs with OM-only proxy tools, replaces the one binding, and proves auth/isolation/replay. It contains no invented ambient declaration or execution engine.

Published reuse added by j00-finish: @jini-ai/cms 0.3.11 (public media types/ports and future service binding), @jini-ai/integrations 0.3.6 (public media-providers async types and future plugin binding). Registry packages are pinned in the lockfile; no sibling source copied or imported. cms 0.3.11 lacks the requested media/import export; that missing upstream surface is recorded as NEEDS.
