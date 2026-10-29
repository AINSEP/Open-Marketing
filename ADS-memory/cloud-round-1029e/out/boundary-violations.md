# Non-cycle boundary violations (om:boundaries)

Source: boundaries-raw.txt. Total non-cycle violations: 2 (manifest, reporting-boundary, FSD, vendor and nonliteral-import checks all clean).

| file:line | import | rule |
|---|---|---|
| packages/contracts/tests/assistant.test.ts:2 | node:fs | impure-contracts (contracts package importing a node: builtin, in a test file) |
| apps/server/src/cli/http.ts:10 | @open-marketing/leads | cli-shortcut (a /cli/ file importing a feature package directly instead of via composition) |

Cycle violations (no-cycles via dependency-cruiser plus graphCycles) are in cycles.md / cycles.json.
