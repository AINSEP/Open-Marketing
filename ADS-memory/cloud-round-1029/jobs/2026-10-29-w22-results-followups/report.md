# Report: 2026-10-29-w22-results-followups

All APPROVED SCOPE items 1–6 are DONE. Details, commands and results are in progress.md.

NEEDS:
- Coordinator: features/leads dist was rebuilt locally by Builder B (`pnpm --filter @open-marketing/leads build`). Rebuild it again after any later edit to leads, because runtime resolves ./dist/index.js (features/leads/package.json `exports.import`).
- JINI ASK (optional, after rc.3): publish a DST-safe local-date → epoch helper. OM's reporting `localDayStart` (apps/server/src/composition/reporting.ts) can then switch to it. It does not block this build.
- None for package.json, pnpm-lock.yaml, contracts, migrations or plugin dists.

DEFERRED:
- Weekly email line: apps/server/src/alerts/email.ts:89 refuses weekly_report.
- created_at index migration: add one only on a measured slow query; it would then need a migrations.ts registration NEEDS.

FOLLOW-UP:
- An existing lint error at apps/studio/src/widgets/workspace-canvas/ui/AlertsFeed.tsx:45 (`renderObservation(text: string)`, om/two-object-arguments) is also present on HEAD.
