# Workspaces

`@open-marketing/workspaces` resolves the authenticated owner of a server session,
checks workspace ownership, and binds an account only to an owned connection in
that workspace. It never adds a second account approval ceremony.

```ts
const service = createWorkspaceService({ repo, identity, ids, clock }, { observer });
const resolved = await service.resolveContext({
  session: { sessionId: serverSessionReference },
  workspaceId: "workspace-a",
});
if (resolved.ok) {
  const result = await service.bindAccount({
    context: resolved.value,
    binding: {
      id: "binding-a",
      scope: resolved.value.scope,
      connectionId: "connection-a",
      externalAccountId: "vendor-42",
    },
  });
}
```

Pass the exact context instance returned by this service. Copies, deserialized
claims, another service's contexts, or changed owner/workspace/principal/trace
fields fail closed. Contexts expire after five minutes using the injected clock;
resolve again after expiration. The identity adapter rechecks the session before
binding, so revocation or identity changes prevent a later write. HTTP/MCP/CLI
composition must authenticate and resolve the session server-side per request;
never accept client-supplied `CallContext` as authority.

The repository and account lookup ports are trusted server storage boundaries.
The service owns authentication; the repository checks scoped workspace existence.
Bind/find context arguments are already authenticated by composition/service. They
validate shape, consistent owner principal, current workspace ownership and full
binding scope; they do not independently authenticate arbitrary serialized
contexts because the contracts provide no session/proof on bind or lookup.

Memory constructors accept trusted `workspaces`, `connections`, and optional
`bindings` seeds (up to 10,000 each). `createMemoryIdentity` accepts trusted session
seeds and an injected clock for expiring sessions; it is a test double, not a login
system. Empty identity configuration fails explicitly.
Each repository (`createMemoryWorkspaceRepo` / `createSqlWorkspaceRepo`) is itself
the `AccountBindingLookupPort`.

`repo.listAccountBindings({ context, query: { limit: 25, cursor } }, options?)` returns `Outcome<Page<AccountBinding>>` for an authenticated owner context only; agents are forbidden and limits are 1–100.
Pages use a keyset ordered by binding ID; a non-null cursor is the last returned ID, and `null` means no more rows.
There is no snapshot across pages, and listing grants no dispatch authority.

`createSqlWorkspaceRepo({ db })` implements repository and lookup
against an injected `WorkspaceSqlDatabase`. The factory performs no I/O or startup.
The server must adapt its
SQLite/@jini-ai/db-shaped shim, enable foreign keys, serialize write transactions
with `BEGIN IMMEDIATE`, supervise timeouts, and handle connection lifecycle.
Numbered `$n` placeholders and `ON CONFLICT DO NOTHING` keep SQL portable to
Postgres. Writes check authoritative connection ownership in the same transaction
as the binding insertion. Exact replay succeeds; changes to an existing scoped
binding ID or external account ID conflict without overwriting the existing row.

The additive migration is `migrations/0001_workspaces.sql`. No migration is applied
by the package. Server provisioning must populate `workspace` and
`workspace_connection_scope` from trusted owner/connection records. Account binding
never provisions authority. The authority table contains no vendor secrets.

Account IDs and binding IDs are scoped by both owner and workspace. The current
lookup contract supplies no vendor namespace; within one workspace, an external
account ID belongs to one connection and cannot silently move to another.

Observers receive operation/outcome and correlation/trace/run IDs, with no sessions,
credentials or owner/account values. Observer exceptions never change a write's
outcome. Port exceptions and malformed output become typed `unavailable` values.
Cancellation checked before dispatch prevents the operation; cancellation after a
completed bind does not replace its actual result. Unknown write outcomes are not
retried automatically; exact replay can reconcile storage on a later request.

The installed `@jini-ai/cms@0.3.11` public identity entry exports `validateSession`
and session repositories. Use it in the integrator-owned `IdentityPort` adapter;
this feature does not rebuild its authentication. Jini's workspace CRUD entry models
names/slugs rather than OM owner/account scope and is not a replacement for this
contract. Dependency/composition changes outside this lane remain integrator-owned.

Tests are written in `tests/`. The same repository and lookup suites target memory
and real in-memory SQLite adapters; the identity suite targets its double and is
ready for the integrator's real identity adapter. No tests, builds, installs or
aggregate gates were run under the owner's 2026-10-02 override.
