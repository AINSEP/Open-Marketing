## Binding context for every wave-1028 job (2026-10-28)
## Binding inputs (read them)
- OWNER DECISIONS: ADS-memory/.local-artifacts/codex-runs/2026-10-13-owner-decisions.md (win over everything else).
- THE BINDING DESIGN for this job: ADS-memory/reports/2026-10-25-om-architecture-debate.md. Read all of it, including the round-3 ballot and the "Owner decisions (2026-10-25)" section at the end, which win on conflict. Raw participant designs with detailed type sketches: ADS-memory/.local-artifacts/swarm-consensus/runs/om-arch-2026-10-25/r2/{opus,codex,gemini}.md (Opus's and Codex's C sections have the most concrete contract sketches; reconcile them with the decisions, don't copy blindly).
- Jini capability map: /Users/la/Programming/Jini/CAPABILITIES.md (indexes the working tree; OM uses only PUBLISHED versions, installed 0.6.12; verify in node_modules/.pnpm/@jini-ai+<pkg>@0.6.12 dist). Reuse Jini where it fits; reusable gaps become upstream Jini asks (additive, opt-in), never OM copies.
- Owner preference: put as much as possible in skills, plugins and agent plugins (swappable); core keeps contracts, safety/approval, durable state, orchestration.
- Simplicity lens (from 12 over-engineering audits): fewest concepts that meet the need; types DERIVED from Zod schemas (no hand-copied declarations); no forwarding layers; no speculative fields; every port input a single object.
- LOAD RULES (owner): NEVER call index_repository, delete_project or any codebase-memory indexing tool; find code by reading files and rg. No full test runs, no om:check, no builds; at most ONE package-scoped typecheck at the end of a build run.
- STATE (2026-10-28): branch om/cleanup-1025, HEAD 867bb92. The working tree holds ~350 UNCOMMITTED files from the 10-25 overnight wave, the 10-26 fix wave, rounds 2 and 3, and the vendor-neutral jobs VN-A0 (contracts), VN-A1 (credentials) and VN-A2a (google/microsoft plugins). That uncommitted work IS what you are fixing: never revert, reset, stash or reformat it, and never touch files outside your lane. NEVER run tests on this machine. Run one package-scoped typecheck per package at the end; you may re-run it ONCE after fixing errors it shows.

# WAVE 2026-10-28: the spec
THE SPEC is your job text below plus the audit/report sections it names. Fix only the items your job text lists.
- ABOUT 12 OTHER CODEX JOBS RUN AT THE SAME TIME in other lanes. Stay strictly inside your lane; anything outside it becomes NEEDS.
- ABSOLUTELY NO TESTS on this machine (owner): never run vitest, jest, playwright, `pnpm test`, om:check, builds or watch modes. Tests are WRITTEN, not run. Twelve jobs running tests would take the owner's machine down.
- VERIFY EACH FINDING IS REAL FIRST: read the current code. Audits and todos go stale; earlier rounds already fixed some items. If one is already fixed or the finding is wrong, list it under DISPUTED with file:line evidence and don't touch it.
- Give each real bug fix a regression test (written, not run) that would fail before the fix. Pure deletions/simplifications need no new test, but move any unique assertion of a deleted test to the surviving suite.
- Make the smallest correct change, in ONE build run. List anything left under DEFERRED with a concrete reason. Never mark undone work as done.
- Every package in your lane must typecheck clean at the end (one package-scoped typecheck per package; one re-run allowed).

# NO OVER-ENGINEERING (owner's standing complaint; a Claude reviewer trims your plan before the build)
- Build only what the job lists. Add no option nobody asked for, and no abstraction, port, layer or helper for a single caller.
- SEARCH FIRST: before adding any mechanism (pagination loop, time budget, CSV/JSON reader, retry, credential parser), find the existing one in this repo (other plugins, packages/contracts helpers, published @jini-ai/* 0.6.12) and extend or reuse it. Name what you reused in the report. Never hand-roll a parallel version.
- Reuse or delete before adding. Report net lines added and removed.
- If you find the same class of problem in several places with no clean local fix, stop and write a short DESIGN NOTE in your report instead of patching it repeatedly.
- Report everything you deliberately left out.

# Constraints from the Tovu/Jini side (tovu-0c, 2026-10-27; binding)
- NEVER read-write or build anything under /Users/la/Programming/Tovu, /Users/la/Programming/tovu-integration-clones/* (prov2-tovu, prov2-jini, tovu-consent, ai-traces-jini), jini-fix1025 or tip-jini. Live agents and the owner's running servers (:3000, :5173) use those trees. Reading /Users/la/Programming/Jini for patterns is fine; never edit it or rebuild any Jini dist.
- Jini contract rules landing after 0.6.12 (OM must already behave this way; don't call any unpublished API):
  1. Each plugin tool takes exactly ONE top-level connection reference. Never accept a second one, or one nested inside free-form input.
  2. Capabilities and tokens live for ONE call. Never cache capability objects, credentials or access tokens across calls or in module-level state. Fetching once per call and reusing it within that call is fine.
  3. Never write code that installs, enables or links a plugin as a side effect of saving a token.
  4. Don't use these unpublished APIs: listSitePluginPackage, sitePluginRoot, readOnlyExtraDirs.
- Per-vendor code stays in that vendor's plugin folder. No vendor code in core, and plugins never import each other.
- Never let an error, refusal, Outcome message or log line echo a token, secret or credential JSON. Add a test where you touch credential parsing.
- Your sandbox makes .git read-only. Don't try to commit, stage or stash.

# Shared decisions (Coordinator, binding; already implemented in contracts/server)
- **Plugin configuration contract:** `pluginConfigurationSchema` and `PluginConfiguration` in packages/contracts (capabilities module). The server passes EXACTLY `{ scope, connectionId, accountId, pluginDigest, settings }`, where `settings` is the plugin's plugin.json OM-extension metadata (install-level options, tainted).
  - Plugins parse `dependencies.configuration` with `pluginConfigurationSchema` and may refine `settings` with their own schema.
  - Account facts (currency, timezone, country) come from the vendor API inside the handler, NOT from configuration.
  - Connection identity fields (customer IDs, client logins, etc.) come from the CREDENTIAL returned by `credentials.access`, not from configuration.
  - No `admitted`/authority/admission fields in configuration.
  - The typed contract now makes most plugins fail typecheck until they align; your job makes them pass.
- **Plugin-local `admitted` checks are removed;** the server invoker is the single gate (one general approval rule). Exception: messaging plugins keep the server-supplied consent `authority` callback (the dispatch-time consent recheck required by COMMON.md §10).
- **Capability declarations:**
  - The server now skips reserved catalog IDs and keeps a plugin's other tools when `createCapabilities` is missing.
  - Still, don't declare canonical capability rows a plugin can't serve: remove them, or implement the factory.
  - Rows whose handler always returns not_implemented should be removed (with their handler).
- **Real-factory test:** every ad plugin you touch gets ONE test that calls its real `createCapabilities` with a configuration built exactly like the server's (`pluginConfigurationSchema.parse({ scope, connectionId, accountId, pluginDigest, settings })`) and a fixture fetch, and gets a valid catalog output.
- **Shared helpers:** keep using the contracts helpers (decimalToMicros, exact-integer JSON, service-context schema). Don't add new local copies.
- **Owner decisions:** finish LINE (TW/TH, not JP-only). Chart plugins ship bundled like Recharts (done by the Coordinator). oe3 uses option A (feature slices own the plugin lifecycle).
- COMING IN JINI 0.6.15 (built for OM, not yet published — do NOT build OM versions of these; mark dependent work "after Jini 0.6.15"):
  - outbox fencing (claim → beginDispatch → complete), reconciliation-only recovery, ack-failure stays uncertain, serial pump;
  - `enqueueWithReceipt` (inserted/existing/conflict) with caller-owned transaction, in-memory reference adapter, conformance suite;
  - sqlite event-log conflict detection + kernel transactions; db checked client, rollback on returned failed Outcome, whole-batch migrations;
  - MCP max response bytes + createMcpToolServer hosting options;
  - fetchWithTimeout injectable fetch + bounded body; public bounded Response reader (onLimit reject|truncate); guarded-reader no-follow;
  - agent-plugin pack options; exact-secrets redaction; fetch-query clock injection.
- Observability/analytics ports are being redesigned in Jini (pending) — don't add new observability plumbing.

# YOU MAY BE RATE-LIMITED OR CUT OFF MID-RUN (many jobs share the account)
Save your progress as you go, so the owner can see what is done if this run stops.
- Keep `progress.md` in YOUR JOB DIRECTORY (the directory named in the "APPROVED PLAN" line, under ADS-memory/.local-artifacts/codex-runs/).
- Update it after EVERY completed scope item, before you start the next one. For each item: DONE (files touched, test written) / IN PROGRESS (what is half-done, and which file is in which state) / NOT STARTED.
- If `progress.md` already exists when you start, this is a RETRY after a cut-off. Read it first, check the files it names, and continue from the first unfinished item. Never redo or revert finished items.
- Leave every file compiling-consistent at each item boundary: finish one item fully before touching the next.
- If you are on the last item or near your limit, update `progress.md` before running the typecheck.

# NO HARD-CODED VENDORS IN CORE (owner, 2026-10-27, binding)
"Nothing should be hard coded. Everything should be an interface or an agentic plugin that we can swap out later."
- Core (apps/*, features/*, packages/contracts) must never name a vendor or provider plugin ID, branch on one, or hold its URLs, headers, token formats or prices.
- Reach plugins only through capability catalog IDs, manifest-declared fields (plugin.json OM extension, credentialCards) and injected ports.
- If your job seems to need a vendor ID in core, STOP and report it under NEEDS instead.
- Write any run-start snapshot / scratch file inside YOUR job dir (ADS-memory/.local-artifacts/codex-runs/<job>/), never /tmp (parallel jobs overwrite each other's /tmp files).

# WAVE 2026-10-29 ADDENDUM (wins over anything above)
- OM is on @jini-ai/* 0.6.15-rc.2 (not 0.6.12). Verify Jini APIs in node_modules/.pnpm/@jini-ai+<pkg>@0.6.15-rc.2/.
- OWNER 10-29: READING and SEARCHING /Users/la/Programming/Tovu and /Users/la/Programming/Jini is ALLOWED (still never write, build, install or index there). Before building any mechanism, search both for an existing implementation. If Jini already has it published, reuse it. If Jini or Tovu has it but it is unpublished or OM-unreachable, write a NEEDS line "JINI ASK: <what>" instead of building an OM copy (the Coordinator relays to Jini). Report what you searched in the plan's Reuse section.
- OWNER 10-29: chat/CLI attachments belong in Jini (ask pending); do not extend OM's own attachment code.
- Recent context: codex-runs/coordinator-notes-1028.md, sections "open-marketing-74" and "open-marketing-f6" (newest), and the 2026-10-28-w18…w21 job dirs (review.md, postcheck.md).
- ABOUT 12 jobs run in parallel again (wave w22). List EVERY file you edit in the plan.
- JINI SOURCES OF TRUTH (tovu-a5, 10-29; wins over the lines above):
  - What OM can call TODAY = published 0.6.15-rc.2 in OM's node_modules. Only this counts for "reuse".
  - What is COMING (rc.3, unpublished) = /Users/la/Programming/tovu-integration-clones/ai-traces-jini (branch fix/analysis-1028; read-only, being edited live). Source-only APIs: ensurePrincipal, createDeadlineSignal {signal, dispose} (shape differs from rc.2), ProviderConfigSource/ProviderKeyUsage/ProviderPluginConfig/ProviderSettingsView, ResponseLimitExceededError + pack options, canonical tool-argument digest, mail-provider create context, a cookie-consent layer (in progress). Never delete or avoid OM code as a "duplicate" of a source-only API; at most a NEEDS "JINI ASK / after rc.3" note.
  - DO NOT use /Users/la/Programming/Jini (stale, branch general-work, 10-20). Ignore its CAPABILITIES.md for API facts.
  - "Missing from published" / "signature differs" between source and rc.2 is EXPECTED, not a finding.
