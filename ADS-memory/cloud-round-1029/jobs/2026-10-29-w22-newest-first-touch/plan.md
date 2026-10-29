Software Architect(Direct):

**1. Summary**

New leads will use the newest eligible paid touch among the latest 100 touches in the existing 30-day window. A full page will no longer discard valid attribution. If that page contains no eligible paid touch, the lead stays unattributed. This is one ≤90-minute implementation run, limited to capture-time attribution.

**2. Files**

- `features/web-events/src/sql.ts` — (edit) descending occurrence time and binary touch-ID order before LIMIT.
- `features/web-events/src/memory.ts` — (edit) matching descending comparator before slicing.
- `apps/server/src/composition/forms.ts` — (edit) select the first eligible paid touch; remove the saturation rejection.
- `features/web-events/tests/port-suite.ts` — (edit) shared ordering, tie-break and >100-touch regressions for both adapters.
- `apps/server/tests/ingress-worker.test.ts` — (edit) capture regressions and existing saturated-page expectation.
- `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-newest-first-touch/progress.md` — (new) implementation progress after each completed item.

Existing fixtures and adapter-suite registrations need no edits. Neither `identity.ts` nor `om-tools.ts` needs an edit.

**3. Public contracts**

No new exports, types, parameters or commands.

Existing repository/service signature remains:

```ts
touchesFor(
  required: { context: CallContext; subjectId: string; window: TimeWindow; limit: number },
  optional?: CallOptions
): Promise<Outcome<readonly AttributionTouch[]>>
```

Returned touches become newest-first: `occurredAt DESC`, then binary `touchId DESC`, limited to 1–100 rows.

Internal `latestPaidTouch(required: { touches: readonly AttributionTouch[] }): LeadAttribution` retains its signature.

**4. Approach**

1. **Verified finding:** SQL currently reads ascending at `sql.ts:83`; memory’s `compareTouches` also sorts ascending. `forms.ts:55` rejects exactly 100 touches.
   **DISPUTED wording:** saturated capture currently becomes unattributed, rather than selecting an old touch. The underlying newest-touch omission is real.
2. Consumer review completed:
   - `WebEventService.touchesFor` validates and projects campaigns while preserving order.
   - `identity.ts:84–87` maps fields without selecting or reversing touches; measure has no downstream `touchesFor` invocation.
   - `om-tools.ts:918` forwards the service result.
   - Remaining references are declarations, catalog/help entries and tests; no further production order assumption was found.
3. Change SQL to `ORDER BY e.occurred_at DESC, t.touch_id COLLATE BINARY DESC LIMIT $6`. Reverse both comparisons in memory’s existing comparator; retain binary-compatible lexical comparison.
4. In `latestPaidTouch`, remove the length-100 guard and return immediately on the first successfully parsed projected campaign. Return the existing null attribution when none qualifies. Update its comment; retain the current window and model version.
5. Write shared-suite regressions:
   - Existing window/binding test expects descending results.
   - Equal timestamps use descending touch IDs, including at the limit boundary.
   - More than 100 stored touches return exactly the newest 100, independent of insertion order.
6. Write ingress regressions using the existing SQL-backed fixture:
   - With >100 touches, the newest observed paid touch wins, skipping a newer direct touch.
   - With 100 newer direct touches and an older paid touch outside the returned page, attribution stays null.
   - Update the existing 100-paid-touch case to attribute to `paid-099`; preserve age, foreign-scope and failed-evidence cases.
7. Update progress, then run once per package:
   - `corepack pnpm --filter @open-marketing/web-events typecheck`
   - `corepack pnpm --filter @open-marketing/server typecheck`
   
   One corrective rerun per package is allowed. Write tests without running them; run no builds or `om:check`.

**5. Reuse**

- Touch retrieval: extend OM’s existing SQL query and memory comparator; reuse their scope, binding, window and limit validation.
- Paid selection: extend existing `latestPaidTouch`, reusing contracts’ `parseCampaignKey` and web-events’ observed-campaign projection.
- Tests: reuse `webEventRepoSuite`, its existing memory/SQLite registrations, and ingress helpers `fixture`, `observedLeadCampaign` and `leadService`.
- Sibling search: searched Jini and Tovu for `touchesFor`, `latestPaidTouch`, `last_paid_touch`, first/last-touch terms and descending touch SQL. No matching attribution implementation was found.
- Checked Jini’s capability map and installed `@jini-ai/cms@0.6.15-rc.2` dist. Its submission reader already supports newest-first submission ordering, but serves different records and cannot replace OM’s touch reader. Existing Jini forms adapters remain in use.
- Attempted npm-registry verification; network access failed. No dependency addition or new Jini API is needed. No additional OSS package is justified.

**6. Deliberately left out**

- Pagination, larger limits, new helpers, ports, indexes or migrations: the bounded newest-first read meets this job.
- Results/reporting changes, historical attribution repair and backfills: capture-time scope only.
- New HTTP, CLI, tool or Studio surfaces: existing callers inherit the corrected behavior.
- **DEFERRED:** none within the requested scope.

**7. NEEDS**

- **NEEDS: Coordinator rebuild `@open-marketing/web-events` dist after implementation and before runtime verification; its runtime export resolves to `./dist/index.js`.**
- Coordinator must serialize the listed files with concurrent jobs, particularly `forms.ts` and `ingress-worker.test.ts`.
- No installs, shared-contract changes, manifest changes or migration registration.

**8. Unverified facts and risks**

No vendor API assumptions are involved. Registry publication could not be independently confirmed; installed rc.2 metadata and dist were inspected.

The latest-100 bound intentionally may omit an older paid touch. If the returned page has none, capture remains unattributed without further reads. Existing observation validation and failed-read fallback remain intact.

Tests will be written but unexecuted, so runtime correctness remains unverified until separately authorized verification.

**9. Size estimate**

Five existing code/test files plus one progress file. Approximately 10–15 source lines added and 10–15 removed; 90–130 test lines added and 5–10 replaced. Net code growth: roughly 80–130 lines. Expected implementation: 60–90 minutes.