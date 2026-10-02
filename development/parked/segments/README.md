# @open-marketing/segments

Independent pure segment compiler. `compileSegment({ definition, tenantId, workspaceId, schema })` validates a versioned AST then returns `{ sql, params, definitionId, definitionVersion }`. Execute the prepared query with a Postgres adapter later; this package never opens a connection, caches membership, reads clocks or imports app code.

SQL selects subjects under mandatory tenant **and workspace** restrictions. Both scope values are bind parameters outside the condition tree. Event subqueries correlate tenant, workspace and subject ID, preventing events from another workspace with the same subject ID from matching. Callers must authorize the supplied scope and ensure their schema mapping represents the intended columns.

Supported conditions: nonempty bounded `and`/`or`, `not`, attribute `eq/ne/gt/gte/lt/lte/in/exists`, and event occurrences in a caller-supplied `[from,to)` window. Events default to existence; optional `count: { operator, value }` compares a nonnegative integer count (including zero). Timestamp strings must use exact ISO UTC with milliseconds, e.g. `2026-01-01T00:00:00.000Z`. No implicit “now”.

Attribute mapping types are string, finite number, boolean and timestamp. Ordering is limited to number/timestamp. Null is accepted only with eq/ne and generates IS NULL/IS NOT NULL. Exists means IS NOT NULL. All ordinary comparisons and IN become false for SQL NULL using COALESCE, so NOT of an ordinary comparison includes null rows. Missing AST values are errors, not null. IN excludes null; express null membership with an explicit OR branch.

All values are parameterized in deterministic depth-first order; tenant is $1 and workspace $2. Operators come from a closed map. Schema identifiers must be simple ASCII SQL identifiers of at most 63 characters and are quoted; no qualified paths, arbitrary SQL, expressions, functions or user-selected raw columns. Unknown AST fields fail closed. Inputs are ordinary data objects; this is not a sandbox for hostile in-process JavaScript Proxies.

Limits: depth 16 (root=1), 1,000 total nodes, 1–100 children per logical group, 1–100 values per IN, 1,000 mapped attributes, and 4,096 characters per string. Definitions are versioned but persistence, immutable publication, approval, schema migrations and live evaluation belong to future callers. Query performance depends on the mapped database schema and indexes; no performance claims are made without database execution.

Run `corepack pnpm --filter @open-marketing/segments test`, `typecheck`, and `build` through the package scripts. Tests assert SQL/parameter contracts and malformed/adversarial inputs; they do not claim database integration coverage.
