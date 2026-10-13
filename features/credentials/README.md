# credentials

Server-only connection lifecycle, authenticated encryption, and scoped credential use.
Public entry: `@open-marketing/credentials`. Factories are inert; composition supplies
database, guarded HTTP, time, IDs, entropy, keys and audit. Never expose the broker,
encrypted records, provider/client configuration or sealer through studio, HTTP/MCP
discovery, agent configuration/environment, transcripts or tool results.

```ts
const service = createCredentialService({ repo, sealer, keyring, oauth, clock, locks, audit });
const begun = await service.beginConnect({ context: ownerContext, request: {
  pluginId: "ads-plugin", returnUri: registeredCallbackUri,
} });
// Show begun.value.authorizationUrl, then accept the server's exact callback.
const completed = await service.completeConnect({ callback });
// completed.value is a connection ID, scope, plugin ID and typed status only.
```

Check every `Outcome.ok` before accessing its value. `beginConnect` and `revoke`
require an authenticated owner matching the scope. Completion binds transaction,
state, exact redirect and expiry, consumes it once, and authenticates sealed data
before returning a summary. Reconnecting creates a new ID; revoked IDs stay terminal.

## Published adapters

- `createAesGcmSecretSealer` adapts `@jini-ai/platform/secrets` AES-GCM to the committed
  OM `gcm1` wire format. AAD binds owner/workspace/connection/version. Entropy is injected.
- `createCredentialKeyring` retains the committed `om.credentials.key.v1:<version>`
  HKDF layout through an injected master loader. Jini's keyring helpers have different
  HKDF layouts, so substituting them would strand ciphertext. OS/file provisioning is host-owned.
- `createJiniOAuthClient` uses `@jini-ai/oauth` browser authorization, PKCE, pending
  state and code exchange. Supply plugin descriptors/clients, a published Jini pending
  store, CSPRNG, exact redirects/origins, app identity, guarded fetch/URL ports and sealer.
- `createJiniCredentialRefresh` uses Jini's expiry and refresh protocol. Bearer token
  JSON is validated and remains sealed outside trusted host code. Scope omission retains
  previous scopes; expansion is denied. Invalid grants produce `reconnect_required`.
- `createSqlCredentialRepo` / `createSqlCredentialAudit` use the host's structural
  query port, atomic version CAS and append-only metadata. No native driver is imported.

The Jini OAuth HTTP port must enforce connection-time DNS/egress policy. OM forwards
abort signals, bounds timeout to 1–60000 ms, forbids redirects, and propagates
correlation/trace/run IDs. Telemetry contains fixed operation metadata only. No grant
is retried automatically. Configure the Jini pending store with capacity at least the
OM maximum (default 256) and TTL no greater than ten minutes. No scheduler is required.

The generic credential-set/vault APIs were inspected but are not a replacement for
OM's terminal revocation and version-CAS repository contract. They also expose suffix
metadata that OM's public DTO deliberately omits.

## Dispatch and recovery

Share one `CredentialLockPort` instance between the lifecycle service and broker.
`createMemoryCredentialLock` is a bounded process-local server lock as well as a double;
multi-process hosts need a distributed adapter. Call `broker.use` at dispatch with a
service context and current version. It rechecks status/version under the lock and
returns encrypted data only. A stale caller gets `conflict`; re-resolve the host-only
record before a subsequent use. The broker's capability must never be cached for a
later transport call. The host owns the barrier through actual transport; the current
public `use` contract does not hold its lock after returning.

After a successful provider rotation, sealing and repository CAS finish even if the
initiating caller disconnects. Dispatch still denies cancellation. A crash or storage
failure between provider rotation and CAS can still require reconnect; this adapter
does not claim remote/local atomicity or retry an unknown rotation.

## Delivery limits

OAuth connection attempts are intentionally process-local and expire on server restart.
Provider-specific SDK/codecs, discovery, dynamic registration, device grants, DPoP,
provider-side revoke and OS key provisioning belong to later plugin/composition work.
No migrations are applied by this package. The inherited `0001_credentials.sql` is an
additive schema for the server migration runner.

Tests cover memory/SQLite compositions and published adapters with injected HTTP,
including the shared port contracts, PKCE, AAD, refresh races and revocation. This job
writes tests but does not run them, builds or `om:check`; only one final package-scoped
typecheck is authorized. See `HANDOFF.md` for evidence and integration requirements.
