# Trim review: 2026-10-28-w21-attachments-cli-tool
VERDICT: APPROVED WITH CUTS

Checked against current code (2026-10-28, after the w18 build and the coordinator's small fixes):
- The job is still needed for the CLI. The server side is done, and the plan's DISPUTED note is correct:
  - The owner upload route exists: apps/server/src/inbound/owner.ts:243 → `uploadAttachment` (:313-324). It reads the query `name`, does a lazy raw read, ignores Content-Type, and returns `Outcome<ChatAttachment>`.
  - Run refs are accepted at owner.ts:336 (`attachments: parsed.value.attachments`) and checked in runs.ts `acceptAttachments`.
  - The barrel export landed: packages/contracts/src/index.ts:12-13 has `chatAttachmentSchema` and `ChatAttachmentRef`.
- The CLI has no attachment support. `om ask` sends `{prompt, conversationId}` only (apps/server/src/cli/index.ts:235). `parseCommand` rejects every repeated flag (index.ts:142).
- The raw body is MIME-independent on the server. inbound/http.ts:37,73 `readRawBody` never checks Content-Type; only `readJsonBody` (:58) does. No CSRF or content-type gate exists elsewhere in inbound/ or composition/. So both octet-stream from the CLI and the Studio header fix are safe.
- Idempotency: the CLI sends `idempotency-key: session.correlationId` on every request (cli/http.ts:224). The upload route and media-library never read it, and dedupe is by digest. So reusing one session for N uploads plus one run is safe. No per-request id is needed.
- `om_runs_start` is not missing by accident. It is deliberately absent:
  - om-tool-coverage.ts:23 `ask: 'Run transport; no recursive runs'`;
  - om-tools.test.ts:587 asserts that `om_runs_create` and `om_runs_start` do NOT exist.
  - The assistant already sees chat uploads as media assets through `om_media_list` (om-tools.ts:838).
- No vendor facts are involved. Jini: there is nothing to adopt. OM's own `readBytes` is the right reader, and the plan's reasoning holds.

CUTS:
1. `om_runs_start` and the matching policy reversal: the om-tools.ts definition, the om-tools.test.ts:587 change and its new tests. Reasons:
   - It reverses a deliberate, test-pinned rule ("no recursive runs").
   - An in-run agent that starts runs multiplies model spend.
   - An agent cannot meaningfully "attach images to a run" it is already in.
   - om-tool parity for chat images is already met: an uploaded image is a media asset, readable via `om_media_list`. Moving bytes through tools is excluded anyway, because of the 64 KiB tool-input bound.
   - See OWNER DECISIONS 1.
   - apps/server/src/om-tools.ts and apps/server/tests/om-tools.test.ts leave the lane. This also removes the collision with w21-p1-5-results on om-tools.
2. The "attach run-start catalog coverage" part of the om-tool-coverage.ts edit. Only the one disposition line in FIX 3 stays.
3. Most of the long CLI regression list: cancellation, authentication/tracing, invalid-ref responses and the exact-byte-cap boundary. `requestOm` already covers auth, tracing and envelope validation, and `readBytes` already covers the byte cap for add-ons. Keep the 5 tests in APPROVED SCOPE item 4.
4. The progress.md line item. ctx-wave-1028 requires it anyway, so it needs no plan entry.
5. The optional picker → upload → run chat-parity test stays DEFERRED. The plan agrees.

FIXES:
1. CLI parsing (cli/index.ts):
   - Add `attach: { type: "string", multiple: true }` to `options` (:12-16).
   - In `parseCommand` (:141-142), exempt only `attach` from the duplicate check, e.g. `names.filter(name => name !== "attach")`. Every other repeated flag must still be rejected.
   - Add `attach: z.array(z.string().min(1).max(4096).refine(path => path !== "-")).min(1).max(4).optional()` to `askInput` (:46-48). Rejecting `-` prevents a double read of stdin when `--prompt-file -` is also used.
   - Pass `attach: values.attach` in the `ask` case (:127-129) and add `"attach"` to `allowed`.
   - Add `attach?: string[]` to the `ask` Command variant (:28).
   - Update the help line (:35).
2. CLI upload: one new helper, `uploadAttachments({ session, runtime, paths }) → Outcome<ChatAttachmentRef[]>`, in cli/index.ts.
   - Keep `ask()` (:226) under complexity 10. It calls the helper only when `attach` is present, after the prompt checks and before the run POST, and then sends `attachments` in the `routes.ask` body.
   - Sequential loop. For each path:
     - name = `basename(path)` from node:path, checked with `chatAttachmentSchema.shape.name`. On failure, return the fixed 'Invalid attachment file name'.
     - Read with `readBytes({ runtime, path, maxBytes: 1048576 })`.
     - Then `requestOm({ session, route: routes.uploadAttachment, query: { name }, rawBody: bytes, signal: runtime.signal })`.
   - The first failure returns immediately, and no run POST is sent.
   - No retries.
   - Error text contains no filename or path. The existing fixed literals are already safe.
3. cli/http.ts:
   - Add `uploadAttachment: { method: 'POST', path: '/api/attachments', schema: chatAttachmentSchema }` to `routes`. That is the "ONE owner route contract", and the coverage test at om-tools.test.ts:578 picks it up automatically.
   - Add `| { readonly name: string }` to `HttpRequest.query` and one `else if ('name' in required.query) query.set('name', required.query.name)` branch to `queryString` (:200). Its complexity goes from about 8 to about 9.
   - Add `readonly rawBody?: Uint8Array` to `HttpRequest`. In `requestOm` (:217):
     - `"content-type": required.rawBody ? "application/octet-stream" : "application/json"`;
     - `body: required.rawBody ?? (required.body === undefined ? undefined : JSON.stringify(required.body))`.
   - The response cap and redirect rejection stay unchanged.
4. om-tool-coverage.ts:23: add the one required key (`satisfies Record<keyof typeof routes, string>` forces it): `uploadAttachment: 'Owner binary image ingress; runs receive refs, assistant reads uploads via om_media_list'`. Leave `ask: 'Run transport; no recursive runs'` unchanged.
5. cli/addons.ts:49: add `export` to the existing `readBytes`. Make no other change.
6. Studio: apps/studio/src/shared/api/http.ts:115: `'content-type': required.rawBody ? 'application/octet-stream' : 'application/json'`. In apps/studio/tests/session.test.ts, extend the existing raw-upload test with that header assertion and check that the run POST still sends application/json.
7. Checks: the build ends with exactly one `corepack pnpm --filter @open-marketing/server typecheck` and one Studio package typecheck, with one rerun each only after fixes. No vitest, builds or om:check. bootServer is untouched (no composition edits).

REUSE:
- Bounded binary file read with deadline and cancellation → apps/server/src/cli/addons.ts:49 `readBytes` (export only)
- Authenticated, traced, redirect-free, bounded HTTP → apps/server/src/cli/http.ts:217 `requestOm` (+ `queryString` :200)
- Upload admission (sniff/allowlist/inspect/dedupe/store) → apps/server/src/inbound/owner.ts:313 `uploadAttachment` → MediaLibrary `uploadImage` (no new route)
- Ref validation and run acceptance → packages/contracts `chatAttachmentSchema` (api/index.ts:68) + apps/server/src/runs.ts `acceptAttachments`
- Filename rule → `chatAttachmentSchema.shape.name` (the same rule the server applies at owner.ts:314)
- Run start/poll/cancel → the existing `ask`/`runTextAsk` flow in cli/index.ts:226,366
- Agent-side visibility of uploads → om-tools.ts:838 `om_media_list`

OWNER DECISIONS (defaults):
1. om-tool attachment surface: default NO `om_runs_start` tool. "No recursive runs" stays. For the assistant, parity is that chat images are media assets it can list via `om_media_list`; HTTP, CLI and Studio can all start runs with images. If the owner wants external MCP clients to start image runs, that is a separate, explicit policy change: an owner-only, fresh-card tool, plus a recursion guard for in-run agents.
2. Partial batch: if file k fails, files 1..k-1 stay uploaded in the media library and no run is sent. This matches w18 OD4 (no cleanup job).
3. `--attach -` (stdin) is rejected. Only real file paths are accepted.

APPROVED SCOPE for B1 (priority order):
1. cli/http.ts: `routes.uploadAttachment`, the `{name}` query variant, `rawBody` support in `requestOm` (FIX 3).
2. om-tool-coverage.ts: the `uploadAttachment` disposition line only (FIX 4). cli/addons.ts: `export readBytes` (FIX 5).
3. cli/index.ts: the repeatable `--attach` flag with schema, duplicate exemption and help text, the `uploadAttachments` helper, and `attachments` in the ask body (FIX 1, 2).
4. apps/server/tests/cli/cli.test.ts. Make the fixture's `readPrompt` able to yield bytes per path, then write exactly these tests:
   a. `ask "x" --attach a.png --attach b.png` sends POST /api/attachments?name=a.png and ?name=b.png with raw bytes and the octet-stream header, then POST /api/runs with the returned refs in order;
   b. a 5th `--attach` is rejected with no fetch;
   c. a file over 1 MiB → `limit_exceeded`, with no upload and no run;
   d. a failed upload response → no run POST;
   e. a repeated non-attach flag (e.g. `--conversation` twice) is still rejected.
5. Studio header fix + session.test.ts assertion (FIX 6).
6. progress.md, then the two package typechecks (FIX 7). Final report: net LOC, DEFERRED (OWNER DECISIONS 1, chat-parity picker test, history images), and NEEDS (none expected).

LOCKS-FILES: apps/server/src/cli/index.ts, apps/server/src/cli/http.ts, apps/server/src/cli/addons.ts, apps/server/src/om-tool-coverage.ts, apps/server/tests/cli/cli.test.ts, apps/studio/src/shared/api/http.ts, apps/studio/tests/session.test.ts, ADS-memory/.local-artifacts/codex-runs/2026-10-28-w21-attachments-cli-tool/progress.md

## COORDINATOR OVERRIDE (open-marketing-74)
1. Defaults accepted: no assistant/external tool starts runs with images (keeps the no-recursive-runs rule); uploaded files stay in the media library if a later step fails; picker test deferred.
