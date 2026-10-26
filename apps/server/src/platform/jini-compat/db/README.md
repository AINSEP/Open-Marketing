# Server migration compatibility shim

Checked query/session infrastructure and its bridge characterization tests now live in `@open-marketing/om-db`. The server composition root owns the native handle and injects the one checked Jini kernel; the bridge retains its existing compatibility names, checked integer decoding, denial rollback, session expiry and uncertain-outcome quarantine. Published `@jini-ai/db@0.6.12` still owns transaction control. No Jini upgrade is included.

This shim retains only migration preparation/execution. It imports the checked bridge through its public package entry point. Migration SQL, checksums, ledger/history validation, size bounds and whole-release rollback behavior are unchanged. `migrations/0001_spine.sql` remains never-applied historical evidence. No live migration runs on import or factory construction.

Feature tests use `@open-marketing/om-db/testing` and supply their own trusted migration SQL, seeds and fault controls. That test-only export is separate from the runtime barrel. File reopening passes an empty migration list. Forms shares the fixture's exact checked kernel with its Jini repositories.

The integrator owns the new package metadata, dependency declarations and workspace links. A later published Jini replacement must demonstrate parity for checked integers, rollback on returned denials, session lifetime, release-error precedence and uncertain-outcome quarantine before this bridge is removed. Migration-runner replacement is separate work.
