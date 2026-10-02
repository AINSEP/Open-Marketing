# Segments checkpoint

Saved: package manifest/build/typecheck configuration, public versioned AST/schema/error types, validation.ts and index.ts compiler implementation.

Implemented: pure validator and SQL compiler with mandatory tenant AND workspace restriction, event correlation on tenant/workspace/subject, typed attributes, half-open event windows, null handling, count predicates and bounded trees. No app wiring or database access.

Tests actually run: none for segments yet. Render predecessor passed 55 tests; its final typecheck/build process was still being polled when this module started.

Saved additionally: tests/segments.test.ts and README.md covering compiler semantics, scope, null handling, event correlation, malicious inputs and tree/list limits. Remaining: execute package checks and fix actual failures. Coordinator owns install/lockfile.

Exact next validation command after implementation: `corepack pnpm --filter @open-marketing/segments test`.

Known limitations: implementation unverified at this checkpoint. Input objects are expected to be ordinary data; hostile in-process Proxies are not a sandbox boundary. Schema supports simple identifiers only, not raw SQL expressions or schema-qualified paths. No claim of completion.
