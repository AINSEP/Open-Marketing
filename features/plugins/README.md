# plugins

`@open-marketing/plugins` owns the running add-on lifecycle for executable plugins,
Agent Plugins and skills. Server composition injects the existing repository and
package adapters, upload decoder, append-only audit, job activity and observer.

```ts
const service = createPluginService({ repo, packages, decodeUpload, audit, runningJobs, observer });
const installed = await service.install({ context, request: { upload } });
if (installed.ok) {
  await service.setEnabled({ context, request: {
    kind: installed.value.kind, id: installed.value.id, enabled: true,
  } });
}
```

Installations and replacements start disabled. Identical uploads preserve activation.
Audit intent precedes publication, activation and removal. Disable still closes the
runtime when intent audit fails and returns reconciliation guidance. Replacement and removal
check durable activity, close admission, then check activity again. Running or
uncertain work retains bytes and metadata; failed enablement closes runtime resources.
Partial effects return reconciliation guidance without authorizing blind retries.
Instruction reads recheck the installed revision and activation after awaiting bytes.

Server adapters reuse published Jini 0.6.12 lifecycle/update, executable-plugin and
skill APIs. Agent Plugin updates pin the resolved old digest; server startup calls
Jini update reconciliation before seeding or restoring runtimes. Recovery failure stops boot. No new journal, registry or approval flow is introduced.
Generation/conversion work without a resolvable plugin identity conservatively blocks
cleanup until it finishes or is reconciled. The server owns SQL, filesystem effects,
credential custody and safety; installation grants no write or spend authority.

Tests cover the lifecycle through fixture and composed Jini/SQL adapters, including
activity races and partial failures. They were written but not run for R2-oe3 B1.
Federation consolidation is deferred to its own run; this change does not replace
the existing running federation host.
