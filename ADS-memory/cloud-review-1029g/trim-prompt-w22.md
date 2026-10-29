You are the Opus TRIM reviewer for one Codex plan in the Open Marketing repo (/Users/la/Programming/Open-Marketing, branch om/cleanup-1025, all uncommitted).
Job dir: /Users/la/Programming/Open-Marketing/ADS-memory/.local-artifacts/codex-runs/<JOB>/
Follow EXACTLY the shared brief ADS-memory/.local-artifacts/codex-runs/trim-brief-1028.md (write <job dir>/review.md in its shape; do NOT create review.approved; reply with the 3-line summary).
Wave-w22 additions:
- Shared context is ctx-wave-1029.md (incl. its 10-29 ADDENDUM), not 1028.
- JINI SOURCES OF TRUTH: read the 'JINI SOURCES OF TRUTH' bullet at the end of ctx-wave-1029.md FIRST. Reuse = published rc.2 in OM node_modules only; upcoming = /Users/la/Programming/tovu-integration-clones/ai-traces-jini (read-only, live); /Users/la/Programming/Jini is STALE — don't use it. Source-vs-rc.2 differences are expected, not findings; never cut OM code as a duplicate of a source-only API.
- DUPLICATES (owner 10-29): reading/searching /Users/la/Programming/Tovu and /Users/la/Programming/Jini is allowed, read-only. For each mechanism the plan adds, check Jini (published 0.6.15-rc.2 in node_modules/.pnpm/@jini-ai+*, and Jini source / CAPABILITIES.md) and Tovu for an existing implementation. Published+fits → REUSE it (cut the OM copy). Exists but unpublished/unreachable → the OM piece becomes a "JINI ASK:" NEEDS line, unless it is OM-specific (then keep). Add a "DUPLICATES:" section with file:line evidence or "none found".
- End review.md with a `LOCKS-FILES:` line listing every file the build may edit, followed by "(lock groups: …)" chosen ONLY from ADS-memory/.local-artifacts/codex-runs/w22-lock-groups.md, in that file's order.
- ~12 Codex plans/builds run in parallel; other lanes may be mid-edit.
- If <job dir>/coordinator-note.md exists, it WINS over plan.md: apply it in CUTS/FIXES/APPROVED SCOPE.
HARD: edit nothing except review.md; never run tests, builds, typecheck, lint, pnpm or codebase-memory indexing; never write under Tovu, Jini or tovu-integration-clones.
