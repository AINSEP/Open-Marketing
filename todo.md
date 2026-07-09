# Open Marketing TODO

Port selectively from `../Open-Marketing-old` into this Open Design-based repo. Treat the old repo as reference material, not a source to copy wholesale.

## Immediate

- [ ] Stabilize the marketing home flow.
  - Keep the new home starters: `Advertise on Instagram`, `Track your Google Ads`, `Create TikTok Ads`.
  - Use the starter flows to learn the campaign pages before committing to final IA.
- [ ] Persist AG-UI campaign actions in SQLite.
  - Current AG-UI campaign commands use an in-memory store in `apps/daemon/src/marketing/campaigns.ts`.
  - Move those actions onto the existing marketing SQLite tables.
- [ ] Add an AG-UI page context pattern.
  - Each campaign page should expose page name, campaign id, current step, form fields, and available actions to CopilotKit/AG-UI.
  - The assistant should be able to summarize the page, fill fields, save drafts, validate, and navigate through typed actions.
- [ ] Add a searchable tool/action registry.
  - Store global tools in SQLite.
  - Add page-local tools for the current form/page.
  - Add `search_tools`, `get_tool`, and permissioned execution through domain actions.
- [ ] Decide the first real vertical.
  - Recommended: Instagram/Meta draft campaign because it exercises the full loop while keeping launch/spend behind approval.
  - Fallback: Google Ads tracking if read-only trust-building is preferred.

## Porting / Cleanup

- [ ] Wire AG-UI chat into the marketing workflow pages.
  - AG-UI/CopilotKit is already present; extend the existing capability instead of re-porting the old integration blindly.
- [ ] Continue the `SettingsDialog.tsx` section-registry refactor. **(monolith 7,441 → 5,905 lines)**
  - Done: `SETTINGS_NAV` registry drives the sidebar; extracted content sections
    `AppearanceSection`, `CritiqueTheaterSection`, `InstructionsSection`; moved the
    already-standalone `NotificationsSection`, `MediaProvidersSection`, and
    `OrbitSection` into `sections/` (Orbit's `persistConfigAndRunOrbit`/
    `configForManualOrbitRun`/`isOrbitRunDisabled` re-exported from the dialog for the
    shim+tests; shared `sanitizeHttpsUrl` promoted to `settings/url.ts`).
  - Also fixed the web unit-test runner: `vitest.config.ts` now inlines
    `@open-design/*` + `@copilotkit/*` deps so their `.css`/CSS-module imports transform
    (was the inherited task-#1 blocker). Settings tests green: 64 + 119 = 183 pass.
  - Still to move (already-standalone, ~mechanical): `ConnectorSection` (~590 lines),
    `IntegrationsSection` + `CodexInstallToggle` (~530) — grep their file-local helpers first.
  - Still inline JSX: `language` (~37, trivial), `about` (~65), `execution` (~1,250, hard —
    entangled with ~800 lines of top-of-file byok/agent/api/codex helpers).
  - See `TODO(settings-section-registry)` near the bottom of `SettingsDialog.tsx`.
- [ ] Replace Open Design branding/content with Open Marketing deliberately.
  - Do not blanket rename design-template/design-system concepts; keep those terms where they refer to the existing rendering catalogue.
- [ ] Adapt privacy/telemetry copy from Open Design to Open Marketing.
  - Update `apps/web/src/components/PrivacyConsentModal.tsx`.
  - Update `apps/web/src/components/PrivacySection.tsx`.
  - Replace "Help improve Open Design" style copy with Open Marketing wording.
  - Update all typed i18n keys/translations in `apps/web/src/i18n/types.ts` and every locale file.
- [ ] Review whether Vite dev bundling is still needed.
  - The copied old-repo task said to use Vite instead of Next for dev. Confirm against this repo’s current Next/Vite hybrid work before changing lifecycle scripts.

## Verify

- [ ] Review `ROADMAP.md` against the current repo implementation.
  - Is the MVP scope still ads-only?
  - Are the campaign pages and tool actions sufficient for the first workflow?
  - What would experienced marketers expect that is missing?
- [ ] Audit any copied skills/agents only after they are actually ported.
  - Verify no content was lost.
  - Validate frontmatter and references.
  - Confirm routing tables match real directories.

## Housekeeping

- [ ] Store an ADR for Mautic as a reference-only architecture source.
  - Reference analysis written up: [`docs/mautic-architecture.md`](docs/mautic-architecture.md) — structure, 6/10 rating, god-objects, cbm-mcp vs graphify cross-check, ranked port targets. Read before porting any Mautic concept.
- [ ] Move durable marketing domain types into `packages/contracts/` as they stabilize.
- [ ] Keep `AI-Dev-Shop/` at repo root.
