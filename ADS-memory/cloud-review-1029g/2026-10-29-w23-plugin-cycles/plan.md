Software Architect(Direct): Persona loaded. Read-only plan; no files changed or checks run.

**1. Summary**

Remove the 16 reported runtime-containing import cycles across the seven plugins using existing files. Move shared declarations to dependency leaves and preserve existing exports, request bytes, validation and failures. Extract one predicate from Meta’s request encoder to bring its complexity from 11 to at most 10. The owner will see unchanged plugin behavior with cleaner dependencies; no new packages, ports or factories are needed.

**2. Files**

Every path below is relative to `content/agent-plugins/`. `E` means the exact directory `io.github.ainsep.openmarketing`.

- snapchat-ads/E/src/ports.ts — (edit) own shared command/configuration/CAPI schemas and derived types.
- snapchat-ads/E/src/commands.ts — (edit) consume and preserve exports of moved declarations.
- snapchat-ads/E/src/capi.ts — (edit) consume moved schemas/types; preserve exports.
- snapchat-ads/E/src/transport.ts — (edit) consume and preserve configuration-schema export.
- snapchat-ads/plugin.json — (edit) refresh affected fingerprint rows.
- snapchat-ads/E/capabilities.json — (edit) refresh matching fingerprint rows.
- microsoft-ads/E/src/ports.ts — (edit) own command/report schemas and derived command type; remove reverse import.
- microsoft-ads/E/src/commands.ts — (edit) consume and preserve command-schema exports.
- microsoft-ads/E/src/reporting.ts — (edit) consume and preserve report-schema export.
- microsoft-ads/plugin.json — (edit) refresh affected fingerprint rows.
- microsoft-ads/E/capabilities.json — (edit) refresh matching fingerprint rows.
- pinterest-ads/E/src/ports.ts — (edit) own command/report schemas and derived command type.
- pinterest-ads/E/src/commands.ts — (edit) consume moved schemas; preserve tool declarations and exports.
- pinterest-ads/E/src/reporting.ts — (edit) consume and preserve report-schema export.
- pinterest-ads/plugin.json — (edit) refresh affected fingerprint rows.
- pinterest-ads/E/capabilities.json — (edit) refresh matching fingerprint rows.
- amazon-ads/E/src/commands.ts — (edit) own existing date schema and report presets.
- amazon-ads/E/src/reporting.ts — (edit) consume and preserve exports of those declarations.
- amazon-ads/plugin.json — (edit) refresh concatenated-source fingerprint rows.
- amazon-ads/E/capabilities.json — (edit) refresh matching fingerprint rows.
- google-ads/E/src/transport.ts — (edit) own shared account/context reads and their existing search helper/schema.
- google-ads/E/src/read-capabilities.ts — (edit) consume moved helpers; preserve existing exports.
- google-ads/E/src/hosted.ts — (edit) import shared reads directly from transport.
- google-ads/plugin.json — (edit) refresh four read/validation fingerprint rows.
- google-ads/E/capabilities.json — (edit) refresh the same four rows.
- meta-ads/E/src/evidence.ts — (edit) own existing capability-context validation and its supporting schemas.
- meta-ads/E/src/read-capabilities.ts — (edit) consume moved context validation; preserve its export.
- meta-ads/E/src/audiences.ts — (edit) import context validation directly from evidence.
- meta-ads/E/src/ports.ts — (edit) own existing Instagram dispatch/request types.
- meta-ads/E/src/instagram.ts — (edit) consume and preserve exports of those types.
- meta-ads/E/src/instagram-fetch.ts — (edit) import leaf types; extract one reporting-path predicate.
- meta-ads/E/tests/read-capabilities.test.ts — (edit) characterize reporting-path acceptance/refusal through real dispatch.
- meta-ads/plugin.json — (edit) refresh reads, audience and Instagram fingerprint rows.
- meta-ads/E/capabilities.json — (edit) refresh matching fingerprint rows.
- meta-ads/E/evidence/primary-sources.json — (edit) refresh only the existing Instagram fingerprint value.
- twilio-sms/E/src/commands.ts — (edit) own schema-derived command/read types and existing credential schema/type.
- twilio-sms/E/src/ports.ts — (edit) consume and preserve command/read type exports.
- twilio-sms/E/src/transport.ts — (edit) consume credential schema/type; preserve current exports.
- twilio-sms/E/tests/dispatch.test.ts — (edit) add malformed-credential secret-sentinel coverage.
- twilio-sms/plugin.json — (edit) refresh SMS read fingerprint.
- twilio-sms/E/capabilities.json — (edit) refresh matching fingerprint.

**3. Public contracts**

No package API, capability ID, tool command or callable signature changes. Existing schema/type exports remain available from their current modules and public indexes.

Moved functions retain these signatures:

- `readContext({ context }): Outcome<CallContext>`
- `readAccount({ dependencies, context }, options?: CallOptions): Promise<Outcome<z.infer<typeof accountSchema>>>`
- `boundContext({ binding, call }): Outcome<CallContext>`

One private extraction: `isAdsReportingRequest({ input, reportingPath }): boolean`, using the existing dispatch input type and unchanged predicate.

**4. Approach**

1. After cloud round 1029f merges, reread the locked files and confirm the reported edges still exist. Preserve concurrent changes; report stale findings as DISPUTED.
2. Complete Snapchat first: make `ports.ts` a declaration leaf, removing its imports from `commands.ts` and `capi.ts`. Move declarations unchanged, including the configuration schema needed by CAPI.
3. Make Microsoft/Pinterest `ports.ts` declaration leaves. Both command encoding and reporting consume the same existing schema objects; remove schema imports from reporting back into commands.
4. Break Amazon’s loop by moving date/preset data into `commands.ts`, which then no longer imports reporting.
5. Break Google’s hosted/read-capabilities loop by relocating their shared reads into existing `transport.ts`. Move the existing bounded search helper with them; do not implement another search path.
6. Move Meta context validation to `evidence.ts`, consumed by reads and audiences. Move Instagram dispatch types to `ports.ts`. Extract the existing reporting-path boolean expression verbatim, preserving evaluation order.
7. Make Twilio `commands.ts` independent of transport/ports by relocating its schema-derived types and credential schema there. Keep parsing behavior in transport unchanged.
8. Retain existing real-factory suites. Write the two focused characterization/redaction additions; run no tests.
9. Recompute fingerprints with `shasum -a 256`, preserving each documented concatenation order. Update only affected rows and report old/new values.
10. Run `corepack pnpm om:boundaries` once and one `corepack pnpm --dir content/agent-plugins/<plugin> typecheck` per touched plugin. Allow one corrective typecheck rerun per package. Require zero runtime-containing cycles in this lane; distinguish unrelated/type-only failures.

**5. Reuse**

- Snapchat, Microsoft and Pinterest: relocate their existing command/report/CAPI schemas into existing declaration modules; keep Zod-derived types.
- Amazon: reuse `reporting.ts`’s date schema/presets directly in commands.
- Google: reuse `readAccount`, `readContext`, `search`, account schema and existing transport.
- Meta: reuse `boundContext`, its supporting schemas, dispatch types and request predicate.
- Twilio: reuse existing credential schema/parser and dispatch fixtures.
- Reuse existing factory tests in each ad plugin; Amazon deliberately exposes no implemented canonical handlers.
- Searched Tovu `apps/`, `packages/` and its cycle-refactor report; the relevant precedent is moving declarations to existing owners, not reusable vendor code.
- Searched authoritative Jini source and installed `@jini-ai/{agent-plugins,integrations}@0.6.15-rc.2` declarations. No matching vendor mechanism was found. Generic API-connection hooks do not replace these codecs.
- npm registry lookups were inaccessible. No dependency addition is proposed; no source-only Jini API is used.

**6. Deliberately left out**

No new files, abstraction layers, dependency installs, cross-plugin imports, transport rewrites, vendor API changes or fingerprint-system redesign. Leave Google’s independent `schemas.ts`/`types.ts` type-only cycle unless this exact move removes it. Keep existing API limitations and admission settings. No HTTP/CLI/Studio work: this job changes no user-facing capability.

**7. NEEDS**

- `Coordinator: build W23-PLUGIN-CYCLES only after cloud round 1029f is merged; acquire locks for every file listed above.`
- `Coordinator: rebuild dist for snapchat-ads, microsoft-ads, pinterest-ads, meta-ads, amazon-ads, google-ads and twilio-sms after source acceptance.`
- Installs, shared contracts, root manifests, lockfile and migrations: none.

**8. Unverified facts and risks**

No new vendor API assumption is introduced. Existing fail-closed behavior remains, including Pinterest’s unavailable reports and uncertain write outcomes requiring reconciliation. The audit calls any loop containing a runtime edge “runtime”; several targeted loops also contain type-only edges. Global boundaries may still fail on other lanes or untouched type-only cycles. Written tests provide no runtime proof until the later authorized verification run.

**9. Size estimate**

One ≤90-minute build: 41 existing files, no new files. Approximately 250–350 source lines relocated, about 20–40 net source lines added, and 35–50 test lines added; fingerprint edits are value replacements. Report actual additions/removals at handoff. DEFERRED: Coordinator-owned dist rebuilds and test execution.