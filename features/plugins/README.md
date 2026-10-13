# plugins

Public entry: `@open-marketing/plugins` only.

This feature validates portable v1.1 packages, verifies host trust and byte pins, and coordinates
install, enable, disable, update (install a replacement), and uninstall. Installation is disabled
by default. Admission is a catalog decision; it creates no write or spend grants.

```ts
const service = createPluginService({ repo, lifecycle, layout, provisioning, trust, audit });
const installed = await service.install({ context, source });
if (installed.ok) {
  await service.setEnabled({ context, pluginId: installed.value.pluginId, enabled: true });
}
```

The app composition root supplies every dependency. `source.expectedDigest` is a verified
lowercase SHA-256 pin, and directory sources must be immutable for the complete operation.
Running jobs block update/removal. Disabling and removal unregister bindings; partial failures
return explicit outcomes and require reconciliation rather than blind retries.

`createJiniArchivePackageReader({ archiveReader, readArchive })` projects the published Jini
streaming archive API into the filesystem layout adapter's `readArchive` callback. Reads are
bounded to 32 MiB/archive, 16 MiB/file, 64 MiB total, 4096 entries, and 65536 chunks/file.
The host bounds I/O duration and decompression buffers and supplies cancellation through a signal.
Directory inspection limits depth to 32 and rejects links. Archive inspection never extracts.

`exportAgentPluginInstructions({ inspection })` returns only plugin identity and screened skill
text. MCP configuration, extension metadata and server credentials are excluded. Trusted package
authors must still avoid embedding secrets in arbitrary prose; the content screen is not a secret
detector.

OM extension declarations use `io.github.ainsep.openmarketing`, version 1. Array declarations
carry capability ID, version, plugin ID, schema fingerprint and shared contract effects. A mapping
can instead reference a capability JSON declaration under the namespace directory and a valid
MCP server. Package declarations may omit `pluginDigest` and `admitted`; the host derives the byte
pin and always returns `admitted: false`. Bound declarations fingerprint their actual JSON bytes.
Author admission/default-tool/risk hints never grant execution.

Published `@jini-ai/agent-plugins` 0.4.3 is reused through `./lifecycle` and `./manifest` exports.
Its installer still requires v1.0, so real OM v1.1 installation is deferred pending upstream support.
The adapter returns `invalid_input` for that unsupported format; it does not rewrite package bytes.
Jini workspace keys must encode both owner and workspace in a lowercase safe segment, for example
SHA-256 of the scope tuple. OM metadata and server safety remain the activation/authority source.

Behavioral B1 suites cover memory, filesystem metadata/layout, archive layout, and lifecycle
adapters. Published Jini lifecycle tests use v1.0 solely to exercise its physical behavior; a separate
test asserts its v1.1 rejection. Tests, builds and `om:check` were not run under the owner override.
See [HANDOFF.md](./HANDOFF.md) for verification status, risks and integration needs.
