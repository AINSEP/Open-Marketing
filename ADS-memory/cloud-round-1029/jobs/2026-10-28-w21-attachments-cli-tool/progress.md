# W21 attachments CLI — B1 progress

Programmer(Direct), 2026-10-28. Approved plan as cut by review.md and Coordinator override.

## Scope and constraints
- Only seven locked source/test files plus this ledger. Preserve all pre-existing edits.
- No tests, builds, installs, om:check, indexing, commits or pushes. End with one server and one Studio typecheck (one corrective rerun only if needed).
- No recursive-run tool, new route, composition, contract, manifest or lockfile changes.
- Approved pattern: existing `readBytes` + `requestOm`, one sequential upload helper returning typed outcomes; schema-derived refs. User-approved review FIX 1–6 supplies the implementation pattern.
- Boundary checklist: injected filesystem/fetch/deadlines; public contracts imports; max four images, 1 MiB each; server owns sniffing/admission; no retries; no run after batch failure; fixed local errors omit paths.
- Test seam: real `runOmCli` with path-specific byte fixtures and recorded HTTP; Studio existing API fixture. Adversarial case: second upload fails after first succeeds, no run submitted.
- Discovery: direct current-file reads/rg per owner load rules; graph tools unavailable; no indexing. ADR index and project_memory.md absent. Current plan/review and binding architecture are the authority.

## Items
1. DONE — cli/http.ts: upload descriptor, encoded name query, raw-body octet-stream support; shared transport limits unchanged. Regression written in item 4.
2. DONE — om-tool-coverage.ts: one upload disposition only; cli/addons.ts: export readBytes only. No separate tests needed for declaration/export; transport regression follows in item 4.
3. DONE — cli/index.ts: repeatable attach only, <=4 real paths (stdin rejected), help, canonical basename validation, sequential read/upload, ordered refs in run body, immediate failure return. Existing prompt/polling flow retained. Tests written in item 4.
4. DONE — server/tests/cli/cli.test.ts: path-specific binary fixture and exactly five tests written (ordered raw uploads/ref run, fifth rejected, overflow, second upload failure/no run, repeated conversation rejected). Not run. Partial-failure test covers the aggregate invariant.
5. DONE — studio/shared/api/http.ts selects octet-stream for raw bytes; session.test.ts existing upload/run test asserts octet-stream then JSON. Written, not run.
6. DONE — final source review complete; server typecheck passed on the authorized corrective rerun; Studio passed on its single attempt. No test/build execution.

## Pre-typecheck review
- All seven source/test diffs compared with this run's in-session baseline (not HEAD); pre-existing lane edits preserved. Source/tests +116 / -23 = net +93 lines; ledger excluded.
- Architecture audit (source inspection): PASS — HTTP-only CLI, injected I/O, canonical schemas, no vendor names or new dependencies, no bootServer/composition edit, no policy reversal, exactly the approved file list.
- Reuse: bounded file reads use cli/addons.ts readBytes; authenticated/deadlined transport and response validation use cli/http.ts requestOm; server owner.ts uploadAttachment calls existing MediaLibrary.uploadImage. Installed Jini platform rc.2 guarded-reader declarations inspected; explicit CLI reads retain the approved existing reader rather than introduce root-policy machinery. No Jini gap copied.
- DISPUTED/already implemented: owner.ts:315 upload handler and :331 startRun accept attachment refs; no new server route/handler needed. Only client route metadata added.
- Function assessment: parseCommand/buildCommand/ask/uploadAttachments/queryString/requestOm/Studio request reviewed for object inputs, fixed limits, typed failures, injected effects and directly reachable test seams. No recorded semantic findings; manual complexity/nesting review stays within <=10/<=3. No lint command run.
- Skepticism pass: rechecked stdin exclusion, four-file bound, raw binary preservation, JSON text-only compatibility, ordered refs, partial failure and variable-name meanings. All five approved CLI tests are retained plus Studio header assertions; no existing assertion removed/weakened. RED/GREEN and coverage remain unmeasured because tests are prohibited.
- Documentation: uploadAttachments documented; ask stale text-only doc updated. requestOm/routes retain existing public docs; readBytes existing doc retained per export-only instruction.
- NEEDS: none identified before checks. No installs, migrations, vendor calls, commits or pushes.

## Typecheck correction
- Server attempt 1: FAILED (exit 2), src/cli/http.ts:230 TS2769 only: generic Uint8Array<ArrayBufferLike> is not a DOM fetch BodyInit.
- Fixed within lane: requestOm copies raw bytes with Uint8Array.from at the native fetch boundary, producing an ArrayBuffer-backed body. No cast, new helper or transport layer; <=1 MiB extra bounded copy for attachments. Existing raw-byte regression checks exact transmitted bytes.
- Plan deviation limited to this necessary compiler correction to the reviewed body expression. Server corrective rerun next; Studio first run afterward. Updated source/tests totals remain +116 / -23 = net +93.
- Server attempt 2 (authorized corrective rerun): PASS, exit 0 for `corepack pnpm --filter @open-marketing/server typecheck` (production + test TypeScript). No further server runs.
- Studio attempt 1: PASS, exit 0 for `corepack pnpm --filter @open-marketing/studio typecheck` (production + test TypeScript). No rerun.

## Handoff
- Approved B1 scope implemented; seven source/test files plus this progress ledger. Source/test net +93 lines (+116/-23), measured against the run-start contents rather than unrelated dirty HEAD changes.
- CONTRACTS: existing ChatAttachmentRef/chatAttachmentSchema and owner POST /api/attachments + POST /api/runs reused. CLI adds repeated --attach; internal HTTP request adds rawBody/name query and reader gains an export. No shared contract, migration, manifest, composition or bootServer changes.
- TESTS WRITTEN, NOT RUN: exactly five CLI regressions and two content-type expectations in the existing Studio upload/run test. No test deleted or weakened. Coverage and runtime self-validation not run because the owner explicitly prohibits test suites/builds here.
- Pre-completion: re-read approved scope; all listed items accounted for; compiler evidence fresh; scope compared against run-start baseline; no unresolved lane error; no commits/pushes; no live effects.
- RISKS: unexecuted regression/runtime evidence; accepted partial uploads remain saved. Byte-copy correction is bounded by the 1 MiB caller limit.
- NEEDS: none. Coordinator can review/integrate; tests remain for an authorized environment. No additional source work deferred from the approved B1 scope.

### Function quality / documentation
Source inspection only; no lint/metric suite invoked. Critical/High semantic findings: 0. Compiler finding was fixed at the native fetch boundary. Existing shared reader behavior was only exported, as required.

| Unit | Disposition | Findings | Local fix attempted |
| --- | --- | --- | --- |
| parseCommand/buildCommand + askInput | NO_RECORDED_FINDINGS | None in source review; <=64 argv entries, <=4 paths, no stdin attachments | Existing parser/schema extended only |
| uploadAttachments | NO_RECORDED_FINDINGS | None in source review; sequential O(total bytes), <=4 uploads, bounded read/HTTP, typed early return | Single helper as approved; purpose/limits/partial failure documented |
| ask | NO_RECORDED_FINDINGS | None in source review; prompt checked before upload and no run after failure | Updated stale text-only documentation |
| queryString | NO_RECORDED_FINDINGS | None in source review; bounded fixed query shapes | One name branch only |
| requestOm | NO_RECORDED_FINDINGS | No remaining source/type finding; existing request bounds/auth/tracing retained | Uint8Array.from resolves fetch body typing without cast |
| Studio request | NO_RECORDED_FINDINGS | None in source review; only MIME selection changes | Existing raw-upload regression extended |

Zero-findings skepticism and variable-name audit recorded above. Effects remain injected, no mutable shared state added, and guards remain directly exercisable through the existing fixtures. Types compile; behavior/coverage remain unverified without running tests. No extra options or speculative abstractions added.

## Deferred / deliberate omissions
- Assistant/external tool run creation excluded by accepted owner default; no-recursive-runs policy retained. Assistant reads uploaded media through om_media_list.
- Picker → upload → run integration test and historical images remain deferred.
- Partial-batch uploads stay in the media library; no cleanup/retry mechanism.
- Runtime/RED–GREEN/coverage verification prohibited by this dispatch; tests will be written, not run.
