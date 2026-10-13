# federation

The server gateway invokes admitted external MCP tools. Reviewed reads run without a card;
all other effects require confirmation of the exact operation and arguments. It rechecks the
catalog, safety decision, approval, broker and dispatch authority before egress, and returns
bounded OM text/JSON results. Unknown outcomes remain unknown and are never retried here.

Public entry: `@open-marketing/federation` only. Factories are inert.

```ts
import { createFederationHost, digestArguments } from "@open-marketing/federation";

// Server composition supplies every port; production dispatch uses safety + the jobs outbox.
const host = createFederationHost({
  connections, transport, credentials, permissionGate, confirmation,
  approvalRepo, dispatchGate, audit, registry, clock,
});
const argumentsValue = { query: "campaign performance" };
const digest = digestArguments({ arguments: argumentsValue });
if (digest.ok) {
  const outcome = await host.invoke({ context, call: {
    operationId, connectionId: trustedConnection.connectionId, toolName: trustedTool.name,
    arguments: argumentsValue, argumentsDigest: digest.value,
    pluginDigest: trustedConnection.pluginDigest, schemaFingerprint: trustedTool.fingerprint,
  } });
  // A returned status of unknown requires reconciliation through the durable jobs owner.
}
```

## Published transport adapters

`createJiniHttpMcpTransport` uses `@jini-ai/mcp/federation`'s `connectMcpHttpSession`.
Supply a fixed `connectionId`, `credentialReference`, `clientInfo`, `timeoutMs` (1..30000),
server-only `spec`, current broker `bearerToken` supplier and `exchange`.

`createJiniStdioMcpTransport` uses `@jini-ai/mcp/federation/stdio`'s
`connectMcpStdioSession`. Supply the same binding and a server-owned `openChannel` callback.
That callback receives only the broker reference and cancellation signal; it owns process
creation, trusted launch configuration, sandboxing, bounded stdout/stderr and process cleanup.
Neither adapter constructs fetch, reads environment/configuration or spawns processes.

Each invocation owns a fresh session and closes it afterward. This adds handshake overhead
but keeps simultaneous operations' authority, arguments and trace metadata independent.
The wrapper adds `io.github.ainsep.openmarketing` MCP `_meta` containing operation/digest/
correlation/trace/run identity at actual send, because Jini's public call API omits metadata.
It checks the dispatch fence after HTTP token lookup and immediately before stdio write.
Dispose cancels active calls, fences pending opens and permits a later distinct invocation.
There are at most 100 active/stalled opens. A late channel/session is closed; cancellation
after handoff maps to unknown. No tool call is automatically replayed.

The HTTP exchange must enforce endpoint/DNS/redirect policy and bound response streaming
**before** producing `text`. Jini's `createFetchMcpHttpExchange` reads `response.text()` without
a streaming cap, so the production composition must inject a guarded exchange. It is used
only with controlled loopback responses in our real fixture. The OM wrapper bounds full RPC
text to 300000 bytes, validates initialize/call response IDs and schemas, and caps MCP/OM
result JSON at 262144 bytes and 100 content items. Only text and structured JSON are projected;
image/audio/resources/links are rejected. Validated successes with an output schema must
include matching structured JSON; failed/unknown results need no success payload.

## Authority and integration

- Catalog names are `io.github.ainsep.openmarketing.<connection>.<tool>`; collisions reject.
  Connection/plugin/schema bindings are independently checked. Only trusted server catalog
  effects classify a read; missing/empty/unknown admission fails closed.
- Confirmation binds frozen canonical arguments, operation, principal, scope, plugin and
  schema. Approval expiry uses the injected clock. Remote annotations never grant authority.
- Production `dispatchGate` must integrate safety and ONE durable jobs outbox, consume an
  operation once, and fence current halt/consent/catalog/approval/credential authority through
  actual egress. The synchronous `isCurrent` probe must reflect all relevant authority epochs.
  Financial/stop/conversion conditions belong to that required safety gate. A confirmation
  ID alone grants nothing. In-memory grants are explicit test controls, never financial authority.
- The broker must recheck revocation/version at final use. Rebinding a connection/reference
  requires replacement transport composition and host reload/catalog readmission.
- Required audit appends intent before egress; completion audit failure maps the result to
  unknown. Observers are redacted, best effort diagnostics, with a bounded memory double.
- Reload verifies connection scope/identity, advances its revision, invalidates catalog and
  disposes transport. It does not rediscover tools or replay operations; readmission is explicit.
- Agent DTOs contain no endpoint, launch config, token or broker reference. Provider text is
  still untrusted content and must never be treated as authority or executable instructions.

Jini's general admission/remembered approval helpers are not used: they do not bind OM's
single exact operation, and their chat/always grants cannot supply destructive or ad-spend
authority. Existing AJV/Zod validation and OM policy logic are retained. AJV supports local
draft-7 schemas, with no remote reference loading, coercion or defaults.

## Verification and deferred work

One shared behavioral suite exists for every owned port, including the observer double.
The same transport and host admission suites target OM memory, published Jini protocol
doubles, and real local HTTP/stdio fixture servers. Additional tests cover authority races,
concurrent metadata, capacity, malformed/oversized results, audit failure and exact bindings.

Tests, lint, boundaries, builds and `om:check` were **written/reviewed, not run**, per the owner
override. See [HANDOFF.md](HANDOFF.md) for the single package typecheck result and coordinator
verification commands. No dependencies were installed or manifests/lockfiles edited.

Deferred to server composition: durable connection/admission storage and authority/approval/
audit adapters, endpoint policy and bounded exchange, process isolation, HTTP/OM-MCP/CLI/studio
wiring, vendor/plugin provisioning and reconciliation. No migration is authored or applied.
