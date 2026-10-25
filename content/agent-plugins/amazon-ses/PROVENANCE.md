# Provenance

Original OM implementation, 2026-10-24. Structure follows OM LinkedIn Ads
`src/{index,ports,commands,transport}.ts`; preserves its inert factory and host gateway ABI.
No Tovu code copied. Shared messaging requirements read from the Resend job/plan/review.
Apache-2.0; LICENSE retained from OM LinkedIn Ads. Runtime dependencies:
OM contracts (workspace), Zod 4.1.13 (MIT), @jini-ai/platform 0.6.12 (Apache-2.0).
Jini public signer declarations/implementation inspected in the installed server package;
always supply injected time. No sibling Jini dependency or custom cryptography.
Exact npm publication/latest could not be verified (registry inaccessible); integrator resolves
the pinned dependency and lockfile. No installs performed.
Official documentation checked 2026-10-24; evidence/primary-sources.json records references.
No AWS account, IAM policy, credentials, delivery or live quota was exercised.
