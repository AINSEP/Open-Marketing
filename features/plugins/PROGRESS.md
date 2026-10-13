# j09 continuation — 2026-10-12

Current objective: finish the committed 3e2648f plugin core while adopting installed published Jini
0.4.3. All edits stay in features/plugins. No commits, pushes, installs, test runs, builds or om:check.
One package typecheck is authorized at the end.

Inputs read: Programmer persona, AI-Dev-Shop entry point and relevant base/pattern/validation
skills; 59db645..3e2648f plugin diff; current index/ports/types; development/JOBS.md j09 and COMMON;
target architecture v2 §§4.5/5/6/9/10; installed public Jini declarations and implementation behind
the declared exports. No prior feature HANDOFF/PROGRESS existed. No matching local ADR index or
project_memory artifact was found in the supplied tree. Graph MCP tools are unavailable.

Preserved: existing service, portable validator, trust/audit/provisioning seams, memory doubles and
filesystem metadata adapter. Continued the committed object-input/Outcome/DI pattern under the
explicit continuation dispatch. No new architecture or separate source implementation was invented.

Findings and changes:

- Update intent was audited after retirement; moved required intent ahead of removal effects.
- Disable returned on failed metadata save without unregistering; cleanup now always runs after
  requested disable, and failures remain typed.
- Package digest declarations imposed a circular self-hash; host byte pins now replace claims.
- Duplicate descriptors and cross-plugin identity are rejected before provisioning/install effects.
- Fixed the invalid fixture effect `spend` to shared contract `ad_spend`.
- Bound archive inspection uses Jini's streaming port and verifies bytes before parsing; observed
  expansion, entry count, chunk count, path/link checks and cancellation are explicit.
- Replaced guessed generic Jini API with the actual public facade types and public exception class.
- Wrote acceptance, adverse aggregate, B1 and published-Jini native filesystem tests.
- Split directory/inventory loops into directly testable steps to keep complexity/nesting bounded;
  report wrong fixed component filesystem kinds explicitly.

Root cause evidence is source inspection; no RED/GREEN execution is claimed because the owner
expressly prohibits tests. The pending verification surface is the Coordinator's combined run.

Upstream gap: Jini 0.4.3's lifecycle parser hard-pins manifest schema 1.0.0. Its public structural
manifest validators do not implement OM's v1.1 grammar, so the retained v1.1 validator remains
necessary. The published packer/reader can inspect v1.1, but real installation is explicitly
unsupported pending a Jini release. No temporary Jini implementation was copied or imported.
An npm registry check was attempted before edits; shell DNS is unavailable and the web tool could
not fetch npm metadata. Installed package.json/.d.ts are the version/API evidence.

Final permitted typecheck: `corepack pnpm --filter @open-marketing/plugins typecheck` failed with
only src/extension.ts:34 TS2322 in production checking. Root cause: the inherited empty descriptor
widened namespace to string. Added an explicit PluginExtensionDescriptor annotation. The command
did not reach test checking; no rerun is authorized. Treat the fix and test sources as unverified.

Next actions: Coordinator runs combined typechecking/tests/build/om:check and resolves
upstream/composition needs. Tests remain "written, not run" unless the owner lifts the restriction.
No loop alert was triggered. No commit/push occurred.
