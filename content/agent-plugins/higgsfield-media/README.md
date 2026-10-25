# Higgsfield image plugin

This plugin adds the server-side pieces for one-image asynchronous generation:
reviewed quotes, exact effect/argument binding, provider status parsing, charge
observations and a guarded media reference. The owner would connect with browser
OAuth, request an image through creative, and see a pending job followed by an
imported media asset. It remains disabled/unadmitted until the host is wired and
current non-spending vendor evidence is approved.

The initial implementation is images only. Video, batches, reference images,
unlim, a live cost-preflight binding and actual vendor charge-schema acceptance
are deferred. Historical guidance is attributed in PROVENANCE.md and NOTICE.

## Server composition

Code/package/scripts live in `io.github.ainsep.openmarketing/`. Import its public
entry after generic plugin admission; never import it into feature core, studio,
desktop or agent. Root workspaces/lockfile remain integrator-owned.

1. Validate the portable package with `@open-marketing/plugins`. Package capability
   fingerprints are inert placeholders; the host hashes binding bytes, pins the
   reviewed package and computes current remote input/output schema fingerprints.
2. Connect using `mcp.json` on the server. `plugin.json` contains OAuth/discovery
   defaults and conservative risk hints under the OM namespace. Additional
   historical discovery hints are in `oauth-discovery.json`; they do not initiate
   registration or authorize credentials. Credentials/PKCE/state/DCR are owned
   by the server credentials broker.
3. Project creative's request to ImageIntent: operation/digest/configuration,
   prompt/model/seed, and `parameters` (only count=1 and supported aspect_ratio).
   Persist the original immutable request/quote. Supply host-verified account,
   scope, package/schema pins and PricingEvidence; unavailable evidence is null.
4. Inject FederationHost.invoke, its canonical digestArguments, job ownership,
   append-only observations, guarded media read, bounded deadline runner, clock,
   IDs and observer. These are structural caller-owned ports with no vendor token.
5. Use `createHiggsfieldDispatchEvidence` to persist the reviewed mapping from
   original intent digest to wire digest. Safety's FrozenGenerationRequest and
   wire quote must use that SAME wire digest. Their effects have accountId and
   moneyExposure null; the separate quote drives the generation allowance.
   Both quote forms preserve quoteId/pricing provenance. Never let a plugin DTO
   or boolean constitute admission; the host independently verifies the mapping.
6. Use `createHiggsfieldRuntimeBinding` for creative's JiniGenerationBinding:

```ts
const prepared = createHiggsfieldRuntimeBinding({ dependencies });
if (!prepared.ok) return prepared;
const runtime = prepared.value;
const binding = {
  pluginDigest: dependencies.binding.pluginDigest,
  configurationDigest: dependencies.binding.configurationDigest,
  deps: { store: scopedDurableOperationStore, signer: runtime.signer,
          httpClient: runtime.httpClient, persistRetryDelaysMs: [] },
  start: { adapter: runtime.adapter, ctx: renderContext,
           providerId: "higgsfield", routeKey: "image-generation.v1" },
  poll: { adapters: lookupScopedAdapter, resolveContext: restoreReviewedContext },
  awaitHandoff: runtime.awaitHandoff,
};
```

Jini `startOperation`, `pollDueOperations` and `recoverAfterRestart` are re-exported
for generic runtime injection. Do not create another outbox or polling engine.
Drive recovery before workers start; the store and row adapter/context lookup
must be scope/operation-specific. In multi-operation workers, resolve each row's
original intent/quote and ownership before dispatch, not a shared mutable context.

The bridge is an in-process HttpClientPort shim that invokes federation. It never
opens a socket. Keep its passthrough signer: server federation obtains current
broker authority and performs the real MCP call. No bearer token belongs in the
Jini row, request arguments, signer state, agent config or media fetch.

`awaitHandoff` waits for the full bounded federation call, including slow admission,
so safety's barrier outlives Jini's interactive grace window. Preserve that ordering.
The deadline port must bound the entire callback and abort/fence delayed egress.
All backend ports must honor its signal; a timed-out callback must not send later.

## Bounds and accounting

- One image/job per operation; prompt <=32768 characters, provider metadata <=64KiB,
  <=16 content entries and <=16MiB image bytes.
- Whole host/media/observation calls <=15 seconds. Poll delay 1–60 seconds.
  Creative validates attempts 1–120, deadline <=one day, tick size <=100 and lease
  1–60 seconds. The injected Jini store/worker enforce these bounds; no loop starts
  at construction/import.
- No verified provider submit idempotency. Stable OM operation IDs flow to federation;
  crashes/timeouts reconcile rather than replay. Local duplicate submits also fail.
- Known quotes require reviewed account/model/configuration/schema AND original-argument evidence.
  Credit conversion uses rational minor-unit arithmetic, rounding up. Expired/unknown
  evidence never becomes zero currency. Explicit charged evidence is required for actuals.
- Charge identities deduplicate status retries; changed amounts conflict and require
  append-only corrections. Record charge exposure even for failure/no asset.
  For an unpolled timeout, host costs projection must append the original estimate
  once a provider handle is durably known; polling is not proof of no prior charge.
- The media port checks public DNS, pinned peers, redirects, MIME sniffing, size and
  completeness BEFORE returning bytes. Preserve ImportReference in source/provenance
  storage under stable operation/job identity; never give OAuth headers to the CDN.

The tests use a synthetic explicit `charge` field, not a claim that current
Higgsfield emits it. `cost.credits_exact` is treated as price evidence only.
Status/refusal/timeout/cancellation does not imply a refund or zero cost.

## Validation handoff

All tests are **written, not run** under j11's dispatch restriction. No builds,
om:check, installs, OAuth registration, vendor calls or live spending were performed.
One lane typecheck is permitted; its result is recorded in HANDOFF.md.

After integrator dependency/composition work, run the namespace package's test,
build and typecheck scripts, then the repository's required gates. Current vendor
acceptance must use approved non-spending evidence before enabling admission.

## H1R1 handoff — 2026-10-24

Distinct failed/cancelled/expired reasons now reach sanitized Jini error codes;
charges remain independent of terminal status. No refund is inferred.
These payload spellings and explicit charge fields remain synthetic contracts.
The fixture regressions cover restart without another submission, owned-handle
read-only reconciliation, missing/unowned handle refusal, immutable unknown rows,
schema drift, the documented conversion, grant reuse and allowance exhaustion.

Checked [Higgsfield's October 2 guide](https://higgsfield.ai/blog/automate-ai-video-n8n-make):
MCP conversion is USD 1 per 20 credits; it describes non-generating `get_cost`
and `jobs_wait`. Combine a reviewed exact-request credit bound with 100 cents/20
credits, rounding upward, through existing PricingEvidence/quote APIs. The rate
alone cannot supply a request bound. Missing, stale or mismatched evidence stays
unknown; estimated costs do not establish actual charges.
[MCP billing](https://higgsfield.ai/creator-hub/help-center/integrations/what-is-higgsfield-mcp)
uses plan credits; [REST estimates](https://docs.higgsfield.ai/docs/concepts/billing-and-retention)
apply to separate API billing. Do not substitute REST or Unlimited/free prices.
The public MCP endpoint returned 401; no authenticated tools/list was available.
[Vendor instructions](https://github.com/higgsfield-ai/cursor-plugin/blob/develop/commands/higgs.md)
require current tool schemas. Existing job_status bindings and admitted:false stay
unchanged; live evidence production/get_cost/jobs_wait mapping remains deferred.

H1 shared completion owns server composition {creative,index,workers,addon-federation,
migrations}.ts, om-tool-types.ts, installed-plugin public loading, durable operation
and canonical-media storage (reserved v21), and verified late-result creative ingestion.
Recover before polling; retain original per-operation bindings and immutable Jini
terminal rows. DS2 owns status/reason/asset links; T1 runs the written suites.
The single H1R1 lane typecheck exited 2 (TS2353, restart fixture httpClient argument); corrected to Jini's optional argument, not rerun. Tests/builds/gates were not run.
