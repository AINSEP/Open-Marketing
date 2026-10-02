# Contributing

Read AGENTS.md and development/COMMON.md. Own one feature directory at a time. Public contracts use named exports from root index.ts and exports only ".". Cross-feature needs are caller-owned ports.

Validate at boundaries, inject I/O/time/IDs/configuration, return typed errors, and fail closed. One shared suite covers each port's double and real adapter. j00 suites prove explicit implementation absence; replace/extend them with behavioral cases during the feature job.

Run om:check plus package-scoped test/build/typecheck. Invalid gate programs are text/virtual fixtures. Do not weaken gates, add inline controls, hide first-party source in output directories, or restore removed application dependencies.

Record source commit, path, license, checksum, adaptation and removal trigger for copied code. Do not apply live migrations or call spending/destructive providers in tests.
