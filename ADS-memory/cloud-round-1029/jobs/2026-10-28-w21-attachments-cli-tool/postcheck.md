### 2026-10-28-w21-attachments-cli-tool: verdict READY TO COMMIT (no required fixes; optional nits only)

Method: I read the job's hunks in `git diff HEAD` for the 7 locked files. Concurrent waves' hunks in the same files (plugin-secret, mail-provider, leads, alerts and w18 Studio upload) are excluded. I confirmed the files Codex edited from the `file_change` events in B1-run.jsonl. I ran no tests, typechecks or builds.

Ledger:
- SCOPE 1, cli/http.ts (FIX 3): FIXED.
  - `routes.uploadAttachment` is at :63.
  - The `{ name }` query variant is at :132, and the `queryString` branch at :203. Encoding is via URLSearchParams.
  - `rawBody?: Uint8Array` is at :133.
  - The octet-stream header is at :224.
  - The body at :230 is `Uint8Array.from(rawBody)`. That copy is the TS2769 typecheck correction and is bounded at 1 MiB.
  - The response cap, redirect rejection and the 15 s deadline are unchanged.
- SCOPE 2: FIXED.
  - om-tool-coverage.ts:23 adds only the `uploadAttachment` disposition. `ask: 'Run transport; no recursive runs'` is unchanged.
  - cli/addons.ts:50 changes `readBytes` to `export` and nothing else. The other addons.ts hunks belong to the plugin-secret/mail-provider waves.
- SCOPE 3, cli/index.ts (FIX 1, 2): FIXED.
  - The option `attach` (multiple) is at :17.
  - The Command field is at :30.
  - The help line is at :37.
  - `askInput.attach` is at :50: min 1, max 4, path ≤4096, and `-` rejected.
  - The ask case's allowed list and input are at :131-132.
  - The duplicate check exempts only `attach` (:146), and other commands still reject `--attach` via `commandInput`'s allowed set.
  - `uploadAttachments` (:228-245) is sequential. It checks the basename against `chatAttachmentSchema.shape.name`, then calls `readBytes` with a 1 MiB limit, then `requestOm`, and returns the first failure. Errors are fixed literals with no path.
  - `ask` (:259-265) uploads only after the prompt checks and sends `attachments` in the run body. When there are no attachments the value is undefined and JSON drops it, so the old body is unchanged.
- SCOPE 4, cli.test.ts (a-e): FIXED, at :85-141.
  - (a) asserts the URL, method, exact bytes and content-type of both uploads, plus the run body with the refs in order.
  - (b) asserts no file read and no fetch.
  - (c) asserts `limit_exceeded`, no request, and that the deadlines were disposed.
  - (d) asserts that only 2 uploads were sent and no run.
  - (e) asserts that `--conversation` twice is rejected before any I/O.
  - Every test can fail. The fixture change (:41-42, :51, :73) is minimal, and existing tests keep `settings.chunks` as the fallback.
- SCOPE 5, Studio (FIX 6): FIXED.
  - apps/studio/src/shared/api/http.ts:115 uses the rawBody ternary.
  - session.test.ts asserts octet-stream on the upload (`calls[0]`) and `application/json` on the run POST (`calls[1].contentType`).
- SCOPE 6, progress and typechecks: FIXED as reported. progress.md is complete. I did not re-verify the typechecks.
- COORDINATOR OVERRIDE 1: FIXED. No `om_runs_start` or `om_runs_create` exists in src. om-tools.test.ts:587 still asserts their absence. Partial uploads stay in the library, and the picker test is deferred.

Outside lane: none. Codex's file_change events cover only the 7 locked files plus progress.md. `apps/server/tests/cli/addons.test.ts` and the extra hunks in cli/http.ts, cli/addons.ts, om-tool-coverage.ts and studio http.ts belong to concurrent waves.

New:
- [MINOR] apps/server/src/cli/index.ts:259-263: images upload before the server learns the run mode.
  - Failure: in Sandbox mode, `om ask x --attach a.png` stores a.png, and then runs.ts:162 rejects the run with 'Image attachments need a model connection.', leaving an orphan asset. Studio behaves the same way (w18), and this is accepted under OD2.
  - Fix: none now. It goes away if the Jini helper or a later pass pre-checks readiness.
- [MINOR] Complexity headroom is now nearly gone. These are counts I made by reading, and all are still ≤10:
  - `requestOm` (cli/http.ts:217) goes from about 6 to 9;
  - `ask` (cli/index.ts:250) goes from about 6 to 9;
  - `queryString` (cli/http.ts:198) goes from 8 to 9.
  - Failure: none today. The next branch added to any of them breaches the gate.
  - Fix: none now. Note it for the next editor.
- [MINOR, outside this lane, note only] apps/server/src/inbound/owner.ts:325: every media admission failure, including a non-image or GIF file, returns 'Image upload unavailable'. A CLI user who attaches a .txt therefore sees a misleading "unavailable" message. The CLI does not pre-check the type, by design, because the server sniffs.
- [NIT] apps/server/src/cli/addons.ts:47-49: the `readBytes` doc bounds list ("<=32 MiB for ZIP or <=64 KiB for token") omits the new 1 MiB image caller.
- Checks:
  - No secrets are echoed: the CLI output has no file path, and the bearer token is unchanged.
  - No capability or token caching was added.
  - No vendor names were added.
  - No composition or bootServer edit (+0).
  - Reusing one session's `idempotency-key` for the uploads and the run is safe. No server code reads it generically; the only reader is inbound/integrations.ts:78, for OAuth start.
  - The ingress cap matches `url.pathname` (inbound/http.ts:37,47), so `?name=` does not bypass the 1 MiB limit.

Disputes/deferrals:
- The plan's DISPUTED note is upheld: the server route and run acceptance already existed (owner.ts:316-326, :336), so no new route was correct.
- DEFERRED-OK: the om-tool run start (OD1, with the coordinator's override), the picker → upload → run test, and history images.

Typecheck:
- Server attempt 1 failed with TS2769 at cli/http.ts:230: `Uint8Array<ArrayBufferLike>` is not a DOM `BodyInit`.
- Codex fixed it with `Uint8Array.from(...)`, with no cast. Attempt 2 passed.
- Studio passed on its first attempt.
- I did not re-run either.

Net lines: B1 reports +116/-23 (net +93) against the run-start baseline. The job's hunks in HEAD diff are consistent with that: about +30 index.ts, +6 http.ts, +2 addons/coverage, +62 cli.test, +2 Studio/session.test. This is additive work; no reduction was promised.

Small fixes (all optional; none blocks the commit):
1. apps/server/src/cli/addons.ts:48: change the doc to `@complexity O(b) time/space, <=32 MiB ZIP, <=1 MiB image, <=64 KiB stdin; one injected read.`

## Jini replacement (owner decision 10-29: attachments move to Jini)

What Jini has today:
- `prepareMessageAttachments` / `messageContentWithImages` exist only in source: tovu-integration-clones/ai-traces-jini packages/daemon/src/attachment-content.ts (daemon 0.6.13 source, CHANGELOG entry).
- They are NOT in the published rc.2:
  - there is no `@jini-ai+daemon` entry in OM's node_modules/.pnpm;
  - a grep of every installed `@jini-ai/*@0.6.15-rc.2` dist finds no match;
  - OM has no dependency on `@jini-ai/daemon` at all.
- Ask Jini to export the helper (and the pending CLI helper) from a package OM already consumes (agent-runtime, platform or chat). Otherwise adding the dependency is coordinator-only work.

What `prepareMessageAttachments` covers:
- It runs on the server/runtime side. It turns refs into `{ mimeType, data(base64) }` images plus a notice for non-image files.
- The host supplies a `read({ ref })` that owns authorization, integrity and MIME sniffing.
- It does NOT cover the client read → upload → ref path that this job and the w18 Studio uploader implement. That is the pending Jini ask.
- Gaps OM must keep closing in its own `read` adapter:
  - it accepts `image/gif` (OM admits only png/jpeg/webp);
  - it has no count or byte caps (OM: ≤4 refs, ≤1 MiB each).

Would be REPLACED by the pending Jini CLI `--attach` and the read → upload → ref helper:
1. apps/server/src/cli/index.ts:
   - `uploadAttachments` at :228-245;
   - the attachments block in `ask` at :259-263;
   - the imports `readBytes` (:1), `basename` (:6) and `chatAttachmentSchema`/`ChatAttachmentRef` (:8-9).
   - The flag plumbing stays if `om` keeps its own parseArgs, and goes if the Jini CLI flag is adopted: option :17, Command field :30, help :37, `askInput.attach` :50, ask allowed/input :131-132 and the duplicate exemption :146.
2. apps/server/src/cli/http.ts: the `rawBody` field, header and body (:133, :224, :230) and the `{ name }` query (:132, :203), but only if the Jini helper owns the upload transport. Otherwise OM keeps them as the transport the helper is given. `routes.uploadAttachment` (:63) and om-tool-coverage.ts:23 stay as long as OM's /api/attachments is the target.
3. apps/server/src/cli/addons.ts:50: revert `export readBytes` to private once the helper does the file read.
4. apps/server/tests/cli/cli.test.ts: the `describe("ask image attachments")` block at :85-141 and the fixture `chunksByPath`/raw-body capture at :41-42, :51 and :73. Replace them with one OM wiring test.
5. apps/studio/src/widgets/om-chat/OMChatPane.hooks.ts (w18): `uploadImages` at :109-126 and the `uploadAttachments` wiring at :99-100, if the Jini helper is isomorphic over browser `File`. `attachmentAccept` (:101) stays as configuration.
6. apps/studio/src/shared/api/http.ts:
   - from w18: `attachments.upload` at :198-206;
   - the `rawBody` support in `request` at :99, :115 (this job) and :117.
   - These go only if the helper owns transport. Otherwise they stay as the injected upload port, and apps/studio/src/shared/api/types.ts `attachments` stays as the port.

Would be REPLACED once `prepareMessageAttachments` is published (w18, server side):
7. apps/server/src/runs.ts:
   - the `resolveRunImages` loop at :188-199;
   - the base64 build at :183 inside `readRunImage`.
   - OM keeps `readRunImage` :175-182 as the injected `read`: media.readImage, the id and workspace equality checks, and the png/jpeg/webp sniff allowlist (`sniffContentType` import at :6).

STAYS in OM (durable state and policy):
- owner.ts:316-326 `uploadAttachment` (ingress, name rule, 1 MiB cap) and inbound/http.ts:47.
- features/media-library `uploadImage`/`readImage` (storage, dedupe, inspection).
- runs.ts:160-173 `acceptAttachments` (≤4 refs, Sandbox rejection, validation before launch).
- The contracts `chatAttachmentSchema`, `assistantRunRequestSchema.attachments` and the context `images` field. Jini's `MessageAttachmentImage { mimeType, data }` already matches the context image shape.
- The agent's runtime/model.ts:203 already uses Jini agent-runtime provider translation, so `messageContentWithImages` is not needed. It is only for stream-JSON runtimes.
