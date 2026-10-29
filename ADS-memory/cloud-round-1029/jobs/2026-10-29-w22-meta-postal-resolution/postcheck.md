### 2026-10-29-w22-meta-postal-resolution: verdict SMALL FIXES (one Coordinator typecheck re-run; optional message tweak)

All meta-ads paths below are under content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/ unless stated otherwise.

Ledger (checked against the code and implementation.diff, which is this job's own baseline diff):
1. src/campaign-translation.ts: FIXED.
   - Signature: `translateCampaign` is async and takes `(required, optional?: CallOptions)` (:36). The input now carries `context`, `dependencies` and `target` with `connectionId` (:12-18).
   - `postalCodes` is removed from the strict `resolvedSchema` (:21-26), so a supplied mapping now fails as invalid_input.
   - Ordering per FIX 6 is preserved (:38-45).
   - Postal path only (:69-76): `createConfiguredDispatch`, then `boundContext`, then `resolvePostalKeys`. Country and radius paths never touch `dependencies`.
   - FIX 1: the search parameters are exactly `type=adgeolocation`, `location_types='["zip"]'`, `q`, `country_code`, `limit:"100"` (:97).
   - FIX 2: the match rule is type zip AND same country AND an exact trimmed, upper-cased name, and the key is used verbatim (:102-105). The envelope is non-strict with ≤100 rows (:81-83).
   - FIX 4: a 30 s aggregate `AbortSignal.any`, a 15 s per-request timeout, `operationId = correlationId`, a read effect with argumentsDigest, sequential calls and no retry or cache (:91-98).
   - FIX 7: fixed error messages; transport failures pass through unchanged (:99).
   - Zips are sorted by key (:78).
   - Complexity under eslint-plugin-sonarjs 3.0.5: translateGeography 7, and resolvePostalKeys exactly 10 (ternary 1, for 1, four nested ifs 8; the filter callback is scored separately). That is at the limit, not over.
2. src/instagram-fetch.ts: FIXED. A single new `targetingSearch` condition (GET, `adsPath === '/search'`, effects exactly `['read']`) at :75, joined into the existing allowlist at :78. Auth, redirect, bound and redaction are untouched.
3. tests/campaign-translation.test.ts: FIXED.
   - Resolved case (:63-95): CA decoy, prefix decoy, padded exact name, request-shape asserts (:90-91) and zero POSTs (:94).
   - Not found, ambiguous and wrong country (:96-108).
   - Supplied mapping rejected with no fetch (:109-117).
   - Radius and existing rows kept.
4. HANDOFF.md: FIXED. 3 paragraphs rewritten (≤8 lines). They cover the v26.0 Targeting Search URL, the 30 s limit and the server NEEDS. "Real postal lookup" is removed from the deferred list.
5. Typecheck plus fingerprint confirmation: FIXED.
   - The meta typecheck passed on the allowed rerun.
   - The current sha256 of the two edited sources appears nowhere in meta-ads (re-checked), so no manifest rewrite was needed.
- COORDINATOR OVERRIDE 1 (30 s deadline, adgeolocation per code): honoured.
- COORDINATOR OVERRIDE 2 (server prepareDestination awaits the translator with context and dependencies): FIXED, with one upstream gap.
  - apps/server/src/composition/agent-plugin-backends.ts prepareDestination:
    - It now gets an `Execution` from `pluginExecution({ ..., connection: target, effects:['read'] }, optional)` and builds `dependencies` with the existing `pluginDependencies(execution)`.
    - It `await`s `translateCampaign({ campaign, target, resolved, context, dependencies }, { signal })`.
    - It is generic, with no vendor branch, and bootServer is untouched. Complexity is 6 (`||` not counted).
  - `prepareCampaign` gained `options?` and forwards it (:83-87).
  - The test at apps/server/tests/agent-plugin-backends.test.ts:1601-1645 uses an async translator. It asserts context, target, resolved, the configuration shape, the dependency keys and signal identity.
  - Upstream gap: the production caller drops the signal. See NEW 2.
- COORDINATOR OVERRIDE 3 (server typecheck once): RUN, BLOCKED. See Typecheck.

Outside lane: none. The job diff touches exactly the 4 meta files plus agent-plugin-backends.ts and its test, which override 2 put in scope.

New:
- [MINOR] apps/server/src/composition/agent-plugin-backends.ts prepareDestination (`if (!execution) return localFailure({ message: 'Plugin unadmitted: ' + ... })`). This is a behaviour change for every vendor and every target, not just Meta postal. `pluginExecution` now also requires `bindingCurrent`: the account binding must match the target's connection, account and scope, and the executable revision must be current. Before, prepare checked only enabled/admitted.
  - Failure: a launch whose target account has no current binding now fails at prepare with the misleading text "Plugin unadmitted: <id>".
  - The gate itself is correct, since credentials must not be built for an unbound account, and the test fixture binds every account to `connection` (test :110), so existing tests keep passing.
  - Fix: optional message change (small fix 2).
- [MINOR, outside lane] apps/server/src/composition/index.ts:377 calls `prepare: input => pluginBackends?.prepareCampaign(input)`, and the campaigns port `prepare` (apps/server/src/composition/campaigns.ts:172) has no options parameter.
  - Failure: in production the `{ signal }` is always undefined, so a cancelled launch still runs up to 200 Meta lookups until the plugin's 30 s deadline.
  - Fix: NEEDS for the Coordinator. Add `optional?: CallOptions` to the campaigns.ts:172 port, and pass it at :193 and index.ts:377. Not blocking.
- No secrets echoed (fixed messages only) and no credential or capability caching: `createConfiguredDispatch` is called per translateCampaign call and credentials are fetched per dispatch. No vendor names in core.

Disputes/deferrals:
- The job text's "literal key" premise was corrected by the review (the old code trusted caller-supplied mappings). Accepted.
- ≈200 codes may exceed the 30 s deadline: DEFERRED-OK (owner default, recorded in HANDOFF).

Typecheck:
- meta-ads: attempt 1 failed with TS2322 because `limit: 100` was a number and the parameters type is `string | boolean`. B1 fixed it to `"100"`, and the rerun passed with EXIT 0.
- server: `tsc --noEmit` failed only in apps/server/src/composition/reporting.ts:51-52 (`Page.nextCursor`).
  - That file is untracked and owned by another running lane (w21-p1-5-results). The current file already reads `read.value.cursor` (:51-52), and contracts `Page` has `cursor` (packages/contracts/src/values/index.ts:30). So the blocker is gone.
  - Because `&&` stopped the script, `tsconfig.tests.json` never compiled. The new agent-plugin-backends.test.ts code (:1601-1645) is not typechecked.
  - agent-plugin-backends.ts itself produced no errors in that run.
  - Smallest fix: small fix 1.

Duplicates: none. Published rc.2 dist has no hits for `adgeolocation`/`location_types` (re-checked with rg). Per the review, Tovu, ai-traces-jini and the stale Jini have none either. rc.2 `createDeadlineSignal` exists, but meta-ads has no @jini-ai dependency, and the native one-liner matches read-capabilities.ts:111. OK.

Net lines: +157/−58 (net +99), per B1. That is consistent with implementation.diff: about 60 lines in meta source, about 50 in tests, HANDOFF reworded, server about 15.

Small fixes:
1. Coordinator: once the w21 lane releases reporting.ts, re-run `corepack pnpm --filter @open-marketing/server typecheck` once. This compiles tsconfig.tests.json and covers apps/server/tests/agent-plugin-backends.test.ts:1601-1645.
2. (Optional) apps/server/src/composition/agent-plugin-backends.ts prepareDestination: change `'Plugin unadmitted: ' + target.pluginId` to `'Plugin unadmitted or account binding not current: ' + target.pluginId`. First check that no test pins the old text (rg "Plugin unadmitted" apps/server/tests).
3. NEEDS, already listed:
   - Rebuild the Meta dist in the SAME integration step as this server change. The server already awaits, so an old synchronous dist also works.
   - Thread CallOptions through campaigns.ts:172/:193 and index.ts:377 (NEW 2).
