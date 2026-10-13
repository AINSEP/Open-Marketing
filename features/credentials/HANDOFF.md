# Programmer(Direct): credentials — 2026-10-12

Credentials keeps vendor tokens on the server, encrypts stored connections, completes
OAuth safely, serializes refresh/revocation, and returns useful reconnect status.
For example: an owner calls `beginConnect`, follows the challenge URL, and the server
passes the exact callback to `completeConnect`; the UI receives a connection summary.
Only trusted server egress uses the encrypted credential broker at dispatch.

This continuation builds on 3e2648f; it does not replace the committed lifecycle,
repository, SQL migration, locks or existing acceptance suites. Runtime application
wiring, durable OAuth attempts, provider-specific flows and production security review
are deferred. Tests are written, not run, under the owner's verification override.

## CHANGED FILES

- `index.ts`: additive published-Jini OAuth/refresh factory and dependency/config types.
- `src/jini-oauth-common.ts`: bounded configuration/token parsers, safe Jini error mapping,
  correlated/cancellable guarded-fetch wrapper and metadata-only observer instrumentation.
- `src/jini-oauth.ts`: Jini authorization-code/PKCE/state/exchange adapter behind OAuthClientPort.
- `src/jini-refresh.ts`: Jini expiry/refresh adapter behind CredentialRefreshPort, preserving
  omitted scopes/refresh tokens and denying expanded scopes.
- `src/sealer.ts`: published AES-GCM adaptation preserving exact gcm1 wire/AAD/HKDF;
  validation detaches crypto inputs before asynchronous key loading.
- `src/oauth.ts`: validates pending capacity (1–256), snapshots callback inputs.
- `src/broker.ts`: reads parsed record snapshots; completed rotation persists even when
  the initiating caller disconnects, while subsequent dispatch remains cancelled.
- `src/rules.ts`: fixed safe recovery messages; encrypted record version/scope/ID consistency.
- `src/locks.ts`: corrected the local Promise library reference to `es2024.promise`.
- `src/memory-repo.ts`, `src/sql.ts`: explicit nullable boundary type arguments exposed
  by the permitted typecheck. The internal failure helper now returns only the failure arm.
- `tests/contract/port-suites.ts`, `tests/contract/memory.test.ts`,
  `tests/contract/jini.test.ts`: shared OAuth/refresh contracts extended for published adapters.
- `tests/jini-fixture.ts`, `tests/jini-oauth.test.ts`: injected HTTP, actual PKCE verifier,
  no-secret outputs, state/replay/redirect denial, cancellation, scope behavior, refresh
  coalescing, terminal grant failure, schema validation and trace propagation.
- `tests/sealer-compatibility.test.ts`: independent committed-algorithm characterization,
  byte-identical fixed-entropy ciphertext, malformed nonce/tag/base64 rejection.
- `tests/boundary-regressions.test.ts`, `tests/refresh-regressions.test.ts`: recovery-message,
  completed-rotation cancellation, mismatched version and async input-mutation regressions.
- `README.md`, `progress-ledger.md`, `HANDOFF.md`: usage, constraints, evidence and resume state.

All edits are under `features/credentials/`. Other jobs' dirty/untracked work was preserved.
No commits, pushes, installs, vendor calls, spend or live migrations were performed.

## TESTS

Written, not run: the inherited shared repo/sealer/keyring/OAuth/lock/audit/broker/refresh/
observer suites, memory/SQLite acceptance, new published-adapter contracts and regressions.
No pass/fail/coverage claims are made. Bug-fix red/green execution is explicitly deferred;
the new assertions target previously erased guidance, dropped rotated credentials, mutable
crypto inputs and mismatched secret versions. No existing assertions were weakened/deleted.

One permitted command: `corepack pnpm --filter @open-marketing/credentials typecheck`.
Result: FAILED (exit 2). The source phase reported the new nullable-refresh generic
inference error, inherited generic inference from an impossible `Outcome<never>` success
arm in the failure helper, nullable repository boundaries and an inherited Promise library
reference lacking `withResolvers`. The test-typecheck phase was not reached.

Those root causes were corrected after the run: the internal failure return is explicitly
the failure arm, nullable repo/refresh boundaries have explicit type arguments, and the
local library reference is `es2024.promise` (its installed declaration was inspected).
No rerun was performed because only ONE package typecheck was authorized. The corrected
source and test types remain UNVERIFIED; the Coordinator must rerun the combined checks.

`git diff --check -- features/credentials`: passed before the final verification.
`om:check`, tests, builds, gate tests, coverage and runtime self-validation were NOT RUN
because the binding owner override prohibits them. The Coordinator runs combined verification.

## CONTRACTS / REUSE

The committed `src/ports.ts` and `src/types.ts` remain unchanged. Existing public factories,
service methods, DTOs, broker result and SQL seam retain their signatures.
`index.ts` only adds `createJiniOAuthClient`, `createJiniCredentialRefresh`,
`JiniOAuthProvider` and `JiniOAuthDependencies` so server/plugin composition can select
published adapters without importing internals. No dependency changes are needed.

Reused installed @jini-ai/oauth 0.2.2 public exports: `beginAuthorizationCode`,
`completeAuthorizationCode`, `isTokenDueForRefresh`, `refreshAccessToken`, `OAuthError`
and public provider/client/pending-store/HTTP types. Tests also use the published pending
store, URL guard and challenge derivation. Reused @jini-ai/platform 0.5.3 public
`AesGcmSecretSealer` and its keyring/envelope interfaces through `./secrets`.
Published declarations were read before implementation. npm website/registry fetches
were attempted but unavailable through the web tool; installed metadata confirms versions.

Not reused: generic credential-set/vault repositories, whose default/deletion/revision/
suffix contracts differ from OM's scope + terminal revocation + exact version-CAS DTOs.
Jini's generic HKDF helpers cannot reproduce OM's committed info bytes; the existing
injected master-loader HKDF wrapper is retained for wire compatibility. No temporary
jini-compat shim is imported. The identity shim/port and platform DB wiring are untouched.
Jini's token-refresher coordinator is unnecessary here: OM's broker already serializes
versioned records, persistence and revocation under one injected lock.

## MIGRATIONS

No migration changes or new migrations. Inherited `migrations/0001_credentials.sql`
remains an additive feature schema; it was not applied. SQLite test fixtures are only
authored tests, never executed in this continuation.

## RISKS / DEFERRED

- Production cryptographic-format and credential-boundary security review is mandatory.
  Typechecking cannot establish security or runtime behavior.
- Broker `use` returns ciphertext and releases its lock before actual transport. The host
  must not cache it; dispatch and revocation need the host's transport authority barrier.
  The existing contract does not make broker + arbitrary later transport atomic.
- Locks and OM callback bindings are process-local. Server restart expires attempts;
  a multi-process server requires a shared lock adapter and durable atomic pending state.
- Provider rotation and repository CAS cannot commit atomically. Completed responses are
  persisted despite caller cancellation, but crash/storage failures or aborted unknown
  responses may still require reconnect. No blind refresh retry is introduced.
- Master-key history/rotation, OS provisioning, provider-side revoke, discovery, registration,
  device grants, DPoP and provider-specific configuration stay in host/plugin follow-up.
- HTTP safety depends on injected URL policy AND connection-time DNS/egress enforcement.
  Clients/providers/resources must remain stable for the lifetime of their connection.
- Full application secret isolation (environment, filesystem, transcript/tool-result
  redaction) is an integration requirement beyond this lane; DTO/sealed/telemetry tests
  exercise the feature boundary only, and are unrun.

## NEEDS

- `apps/server` composition: inject the server-owned SQLite query port, guarded OAuth
  HTTP/URL policy, OS master-key loader, CSPRNG, bounded Jini pending store and shared locks.
- Federation/server dispatch: own the transport barrier through credential use and actual
  egress; never expose or retain host ciphertext as an agent tool result.
- Coordinator: combined tests/build/typecheck/om:check and independent security review.

No manifest/lockfile/shared-contract edit or new package install is required by this lane.

## HANDOFF / AUDIT

Architecture audit: WARNING for the documented host transport barrier and process-local
state limitations. Source review found no cross-feature/native-driver/ambient I/O imports,
service startup or secret-bearing public DTO addition. Scope and dependency rules, injected
I/O, terminal revocation, CAS, AAD identity/version, correlated metadata, no retries and
the two-object signatures were reviewed. Mechanical lint/boundary evidence remains unrun.

Pre-completion: active contracts and j07 acceptance reread; prior code retained; fresh
scoped diff checked; test integrity reviewed; typecheck evidence recorded below when run.
Self-validation: not run, explicitly prohibited by the owner's no-test/build override.
No formal pipeline certification, implementation outline, project_memory.md or scoped
credential CIC artifact was present; the dispatch, committed contracts and architecture
provide the implementation boundary. Existing committed factory style was continued.

Function quality assessment (manual; mechanical/runtime evidence INCONCLUSIVE):

| Units | Disposition | Findings | Local action |
| --- | --- | --- | --- |
| AES seal/open, jiniSealer, decrypt, matchesBinding | INCONCLUSIVE | Runtime format/security proof unrun | Kept old bytes; added independent compatibility/security assertions; snapshot validation |
| createJiniOAuthClient, exchange | INCONCLUSIVE | Local pending/transport proof unrun | Published PKCE/grant reuse; exact bindings, bounded parsing, scopes and typed errors |
| createJiniCredentialRefresh, validateRefreshInput, readTokens, refreshDue | INCONCLUSIVE | Remote rotation/DB commit is not atomic | Lock/CAS; finish known rotation storage; no retry; documented reconnect recovery |
| resolveProvider, parseTokens, jiniBoundary, mappedOAuthError, oauthTimeout | INCONCLUSIVE | Runtime boundary branches unrun | Strict bounded parsing; fixed redacted typed messages; injectable HTTP |
| correlatedFetch, observeOAuth | INCONCLUSIVE | Host must enforce connection-time DNS | No payload logs; correlated metadata; cancellation and observer-failure isolation |
| createBoundOAuthClient callback/capacity, failure, recordSchema, readCurrent, storeRefresh | INCONCLUSIVE | Regression red/green deferred | Capacity/snapshots/consistent records; preserve known rotation despite cancellation |
| Nullable repository boundaries and lock Promise library reference | INCONCLUSIVE | Observed typecheck failure; corrections not rerun | Exact nullable generics, failure-only helper return and installed ES2024 declaration reference |

Coverage could not be measured because tests are prohibited. Tests map directly to crypto,
protocol, concurrency, lifecycle/status and redaction boundaries. No own-function signature
exceptions were added; foreign array, Promise, Vitest and HTTP ABIs use narrow wrappers.
Documentation: new public factories/configuration documented; sealer/README stale docs
updated; tiny leaf helpers inherit their enclosing assessment. Time/space/resource bounds
are documented at the adapters and meaningful internal helpers. No runtime gate is claimed.

Critical/High finding count is not established by independent/mechanical review; no
unresolved source-level type error is claimed fixed by execution. The failed verification
and mandatory production security gate remain explicit open items. Variable-name review
checked current/rotated versions, scopes, timeout values and pending state; no inverted
or misleading computed names were identified. Zero-findings skepticism is not applicable
because findings/evidence limitations are recorded above.
