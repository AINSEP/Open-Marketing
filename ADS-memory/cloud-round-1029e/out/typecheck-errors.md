# Typecheck errors

om:typecheck (pnpm -r typecheck, 25 of 26 workspace projects; default run bails at first failure, re-run with --no-bail): only apps/studio failed. All other workspace packages (agent, desktop, server, contracts, om-clock, om-db, all features) passed.
Plugins (content/agent-plugins/*) are NOT workspace members; their typecheck was run per directory: 22 had a typecheck script, 21 passed, content/agent-plugins/higgsfield-media failed. 6 dirs have no package.json/typecheck (anthropic, email-lifecycle, google, om-playbook, openai, seo).

**Totals: 46 errors = apps/studio 2 + higgsfield-media 44.**

## apps/studio (tests tsconfig: tsc -p tsconfig.tests.json) (2 errors)

- apps/studio/tests/conversion-grants.test.ts:97 TS2531 Object is possibly 'null'.
- apps/studio/tests/conversion-grants.test.ts:97 TS2339 Property 'grantId' does not exist on type 'string | number | boolean | JSONType[] | { [key: string]: JSONType; }'.

## content/agent-plugins/higgsfield-media (paths relative to content/agent-plugins/higgsfield-media/io.github.ainsep.openmarketing/) (44 errors)

- src/adapter.ts:3 TS2307 Cannot find module '@jini-ai/integrations/media-providers' or its corresponding type declarations.
- src/adapter.ts:39 TS7006 Parameter 'input' implicitly has an 'any' type.
- src/adapter.ts:43 TS7006 Parameter 'input' implicitly has an 'any' type.
- src/adapter.ts:51 TS7006 Parameter 'input' implicitly has an 'any' type.
- src/adapter.ts:56 TS7006 Parameter 'input' implicitly has an 'any' type.
- src/bridge.ts:4 TS2307 Cannot find module '@jini-ai/integrations/media-providers' or its corresponding type declarations.
- src/bridge.ts:39 TS7006 Parameter 'input' implicitly has an 'any' type.
- src/bridge.ts:52 TS7006 Parameter 'input' implicitly has an 'any' type.
- src/index.ts:16 TS2307 Cannot find module '@jini-ai/integrations/media-providers' or its corresponding type declarations.
- src/types.ts:2 TS2307 Cannot find module '@jini-ai/integrations/media-providers' or its corresponding type declarations.
- src/types.ts:5 TS2339 Property 'ctx' does not exist on type 'unknown'.
- tests/federation-integration.test.ts:4 TS2307 Cannot find module '@open-marketing/federation' or its corresponding type declarations.
- tests/federation-integration.test.ts:5 TS2307 Cannot find module '@open-marketing/federation' or its corresponding type declarations.
- tests/federation-integration.test.ts:24 TS2322 Type '{ generationSchemaFingerprint: unknown; pluginId: "higgsfield-media"; pluginDigest: string; configurationDigest: string; connectionId:
- tests/federation-integration.test.ts:24 TS2322 Type '{ generationSchemaFingerprint: unknown; evidenceId: string; source: string; observedAt: number; expiresAt: number; pluginDigest: strin
- tests/federation-integration.test.ts:34 TS7006 Parameter 'input' implicitly has an 'any' type.
- tests/federation-integration.test.ts:34 TS7006 Parameter 'options' implicitly has an 'any' type.
- tests/federation-integration.test.ts:42 TS7006 Parameter 'input' implicitly has an 'any' type.
- tests/federation-integration.test.ts:42 TS7006 Parameter 'options' implicitly has an 'any' type.
- tests/federation-integration.test.ts:44 TS7006 Parameter 'input' implicitly has an 'any' type.
- tests/federation-integration.test.ts:52 TS7006 Parameter 'input' implicitly has an 'any' type.
- tests/federation-integration.test.ts:59 TS7006 Parameter 'input' implicitly has an 'any' type.
- tests/federation-integration.test.ts:59 TS2322 Type '{ generationSchemaFingerprint: unknown; pluginId: "higgsfield-media"; pluginDigest: string; configurationDigest: string; connectionId:
- tests/federation-integration.test.ts:62 TS2322 Type '{ generationSchemaFingerprint: unknown; pluginId: "higgsfield-media"; pluginDigest: string; configurationDigest: string; connectionId:
- tests/federation-integration.test.ts:62 TS2322 Type '{ generationSchemaFingerprint: unknown; evidenceId: string; source: string; observedAt: number; expiresAt: number; pluginDigest: strin
- tests/runtime.test.ts:2 TS2307 Cannot find module '@jini-ai/integrations/media-providers' or its corresponding type declarations.
- tests/safety-integration.test.ts:3 TS2307 Cannot find module '@open-marketing/safety' or its corresponding type declarations.
- tests/safety-integration.test.ts:4 TS2307 Cannot find module '@open-marketing/safety' or its corresponding type declarations.
- tests/safety-integration.test.ts:37 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:37 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:37 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:41 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:45 TS2571 Object is of type 'unknown'.
- tests/safety-integration.test.ts:46 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:54 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:64 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:64 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:64 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:65 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:72 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:72 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:72 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:74 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:75 TS7006 Parameter 'input' implicitly has an 'any' type.

higgsfield-media by code: TS2307 x9, TS7006 x14, TS2339 x1, TS2322 x5, TS18046 x14, TS2571 x1
Root causes visible in output: unresolved modules @jini-ai/integrations/media-providers, @open-marketing/federation, @open-marketing/safety (not resolvable from the plugin dir, then cascading implicit-any/unknown errors).
