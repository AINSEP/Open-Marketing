Software Architect(Direct):

**1. Summary**

Add `om ask "Describe this" --attach image.png`, with repeated flags for up to four images. The CLI uploads each file through the existing owner route, then sends the returned refs with the run request. Add an om-tool operation that starts a run with those same refs, and correct Studio’s raw-upload content type. Existing server code remains responsible for format detection, image limits, scope checks and model delivery.

**2. Files**

- `apps/server/src/cli/index.ts` — (edit) attachment flags, validation, uploads, ref forwarding and help.
- `apps/server/src/cli/addons.ts` — (edit) export the existing bounded `readBytes` function for attachment reuse.
- `apps/server/src/cli/http.ts` — (edit) upload route descriptor, filename query and raw-byte request support.
- `apps/server/src/om-tools.ts` — (edit) one schema-bound `om_runs_start` definition using existing run services.
- `apps/server/src/om-tool-coverage.ts` — (edit) attachment ingress disposition and run-start catalog coverage.
- `apps/server/tests/cli/cli.test.ts` — (edit) binary-aware fixture and attachment regressions.
- `apps/server/tests/om-tools.test.ts` — (edit) run-start approval, validation and ref-forwarding coverage.
- `apps/studio/src/shared/api/http.ts` — (edit) octet-stream header for raw uploads.
- `apps/studio/tests/session.test.ts` — (edit) extend existing upload regression with header assertions.
- `ADS-memory/.local-artifacts/codex-runs/2026-10-28-w21-attachments-cli-tool/progress.md` — (new) implementation progress ledger.

No composition, manifest, lockfile, contracts, feature or plugin edits.

**3. Public contracts**

- Command: `om ask <prompt> --attach <file> [--attach <file>…]`; also works with existing `--prompt-file`, `--conversation` and `--json`.
- Tool: `om_runs_start({ prompt, attachments?, conversationId? }) → Outcome<RunReceipt>` through the existing dispatcher envelope.
- Derive tool input from `assistantRunRequestSchema`, omitting browser session/binding fields. Reuse `chatAttachmentSchema` and `routes.ask.schema`.
- Internal export: `readBytes({ runtime: CliRuntime, path: string, maxBytes: number }) → Promise<Outcome<Buffer>>`.
- Extend existing `requestOm<T>({ session, route, query?, body?, rawBody?, signal? })`; raw bodies use octet-stream. No new transport API or port.

**4. Approach**

1. Verify the current files again after acquiring locks; preserve concurrent work.
2. Add repeatable `attach` to native argument parsing. Exempt only that flag from duplicate rejection; validate at most four bounded, nonempty file paths. Reject attachment stdin (`-`); preserve prompt stdin.
3. Export and reuse `addons.ts`’s binary reader, retaining its deadline, cancellation and buffer bounds. Validate each basename with `chatAttachmentSchema.shape.name`; read at most 1 MiB per file.
4. Upload sequentially to `POST /api/attachments?name=…`, using the existing authenticated `requestOm` machinery with raw bytes. Parse each returned ref with `chatAttachmentSchema`. Send no run request after any read/upload/response failure; never retry uploads automatically.
5. Forward only returned refs on the existing `POST /api/runs`. Preserve text-only behavior, receipt output, polling and cancellation.
6. Add `om_runs_start` to `assistantDefinitions`, calling `services.runs.start` directly. Use the existing `ownerOnly` write-card behavior: each tool-triggered start requires fresh owner confirmation, preventing unattended recursive starts. Reuse dispatch-time authority checks.
7. Correct Studio’s header when `rawBody` is present; JSON requests retain their current header.
8. Write regressions, without running them:
   - CLI: upload-before-run ordering; four files accepted/fifth rejected; exact byte cap and overflow; failed reads/uploads; invalid refs; cancellation; authentication/tracing; repeated unrelated flags still rejected.
   - Tool: discovery schema; refs forwarded unchanged after confirmation; malformed/fifth refs rejected; cancellation/revoked authority causes no start; replay does not start twice.
   - Studio: raw upload uses octet-stream; subsequent run request uses JSON.
9. At build completion run only `corepack pnpm --filter @open-marketing/server typecheck` and the equivalent Studio typecheck. One rerun per package only after fixing reported errors. Run no tests, builds or `om:check`.

DISPUTED/already complete: owner upload and run-ref HTTP support exist at `apps/server/src/inbound/owner.ts:245` and `:336`; no handler or route implementation is needed. `bootServer` receives zero changes.

**5. Reuse**

- Binary reads: `apps/server/src/cli/addons.ts:49` `readBytes`, backed by existing `CliRuntime.readPrompt`; real consumers are add-on uploads and attachments.
- HTTP auth, deadlines, redirects, response validation and tracing: `apps/server/src/cli/http.ts` `requestOm`.
- Upload admission/storage: existing owner handler → public `MediaLibrary.uploadImage`; no duplicate sniffing or storage logic.
- Ref limits and canonicalization: contracts’ attachment schemas and `apps/server/src/runs.ts` `acceptAttachments`/`readRunImage`.
- Tool registration/approval: existing `assistantDefinitions`, `serviceDefinition` and owner-only continuation.
- Studio regression: existing raw-upload/run test in `apps/studio/tests/session.test.ts`.
- Checked Jini’s capability map and installed `0.6.15-rc.2` declarations. Its guarded filesystem reader introduces root-policy machinery unnecessary for explicit CLI files; retain OM’s existing reader. The Jini CLI registry would replace working parsing unnecessarily.
- npm registry verification was attempted but unavailable through browsing and local DNS. No dependency addition or unpublished API is proposed.

**6. Deliberately left out**

- History images, documents, cleanup jobs, upload retries and attachment mutation after run acceptance: outside this job.
- Binary/base64 tool uploads: image refs keep tool inputs within their existing 64 KiB bound; bytes use the owner upload route.
- New filesystem ports, upload services, registries or generic configuration: existing mechanisms suffice.
- DEFERRED: optional picker → upload → run UI test. Existing session/HTTP regressions cover this change; picker integration would expand the ≤90-minute run.

**7. NEEDS**

- No installs, shared-contract changes, migrations or other-lane implementation.
- Coordinator locks the exact file list above, particularly shared CLI, om-tool and Studio files.
- Review the explicit catalog-policy change: replace “no recursive runs” at `om-tool-coverage.ts:23` and its assertion at `om-tools.test.ts:587` with owner-confirmed run creation.
- Existing contracts/media-library runtime artifacts must include W18 exports; rebuilds remain Coordinator-owned.

**8. Unverified facts and risks**

- No new vendor API assumptions; existing media validation and provider image delivery remain unchanged.
- Registry publication could not be independently reconfirmed; implementation uses installed dependencies only.
- Successful uploads preceding a later failure remain in the media library, matching W18’s owner decision. No partial run is submitted.
- Existing run acceptance rejects foreign, missing, trashed, oversized or unsupported images and sandbox attachments. Tool failures retain explicit dispatcher outcomes and must not advertise automatic retry.
- This planning run made no edits and ran no checks. Written regressions will remain unexecuted on this machine.

**9. Size estimate**

Nine code/test files plus one progress ledger; one build run, approximately 75–90 minutes. Estimate source **+100–160 / −5–15 LOC**, tests **+140–210 / −2–8 LOC**; net approximately **+220–360 LOC**. No new runtime abstraction.