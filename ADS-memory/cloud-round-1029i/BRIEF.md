# OM cloud round 1029i — remaining lint + 8 small cycles (Sonnet)

You are the COORDINATOR. Delegate to 2 **Sonnet** subagents (A: lint, B: cycles). Context: `ADS-memory/cloud-round-1029h/REPORT.txt` (sections 1–2). Rules: `development/COMMON.md` (`fn(required, optional?)`, complexity ≤10, nesting ≤3, types from Zod).

## Hard caps
Stop new work at 25 min; write `ADS-memory/cloud-round-1029i/REPORT.txt` and push by 30 min. Sonnet only. `pnpm install --frozen-lockfile` only; no lockfile/package.json changes. Node 24: `PATH=/opt/node24/bin:$PATH`. No live vendor calls. **Behaviour byte-identical; never weaken a test.**

## OUT OF SCOPE (do not touch)
`content/plugins/charts-*`, `content/agent-plugins/resend-email`, `content/agent-plugins/amazon-ses`, `content/agent-plugins/twilio-sms`, `content/agent-plugins/higgsfield-media`, the openai/anthropic/google model plugins — these are moving to Jini.

## A. Lint
Run `corepack pnpm om:lint`. Fix every `om/two-object-arguments` and `sonarjs/cognitive-complexity` finding OUTSIDE the out-of-scope paths (1029h saw e.g. line-ads transport.ts:79, apps/server/src/composition/agent-plugin-backends.ts ~:1103, apps/server/tests/public-ingress.test.ts, features/measure/tests/links-grants-boundaries.test.ts :50,:94,:113). Convert to `fn(required, optional?)` with no behaviour change; update callers.

## B. The 8 remaining cycles (om:boundaries)
features/jobs/src/{types,schema}.ts; apps/studio/src/shared/api/types.ts; google-ads schemas.ts; line-ads commands.ts; reddit-ads ports/commands.ts; vk-ads ports/commands.ts; whatsapp-business transport/ports.ts (resend-email is out of scope). Break each with the smallest move (leaf type module, type-only import, or pass the function in). Plugin files hashed in plugin.json/capabilities.json/evidence: recompute fingerprints exactly as each plugin's manifests test expects.

## Verify
`om:lint` (0 findings outside out-of-scope paths), `om:boundaries` (only out-of-scope cycles left), typecheck of every touched package/plugin, and the tests of every touched package/plugin once.

## Output
Branch `cloud/om-round-1029i` from `main`; explicit-path commits, no co-author trailers; push; never push to main. `REPORT.txt`: lint and cycle counts before/after, files changed, tests run with results, anything left and why, time used.
