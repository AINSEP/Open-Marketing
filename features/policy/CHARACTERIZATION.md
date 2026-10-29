# Preserved policy behavior

Before repository implementation, read the approved algorithms in src/gates.ts and
all existing tests/gates.test.ts. No substantive gate changes are planned.
Characterization tests are preserved and not executed under the 2026-10-02 override.

- Withdrawal wins over grants in either order and remains effective after its end.
- Purpose and channel/destination match exactly; grant intervals are half-open.
- Suppression blocks messaging only; measurement still needs destination consent.
- Marketing/audience holdout differs from transactional/measurement intent.
- Frequency limits deny at the limit, including zero.
- Halt, missing/revoked authorization, currency mismatch and expired windows deny.
- Subtraction avoids overflowing aggregate committed/reserved integer amounts.
- Gates do not mutate snapshots, reserve money, or confer dispatch authority.

Repository seams are tested through PolicyRepoPort and the public service. Adversarial cases: duplicate evidence IDs with changed payloads,
concurrent duplicate appends, withdrawal in merged subject snapshots, merge cycles,
owner/workspace mismatch, and caller mutation after append. The same suite will
exercise memory and injected SQL adapters using an isolated SQLite test database.
