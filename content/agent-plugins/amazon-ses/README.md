# Amazon SES — R1 reads/auth

After host integration, ask “check my SES sending quota” or “is my SES domain verified?”.
This inert, disabled plugin reads regional account access/quota/pricing-plan and the configured
domain's verification/DKIM status. Domain readiness alone never authorizes marketing delivery.
There are no send commands in R1. No server/studio changes, migrations or live calls.

Create a least-privilege **IAM user**, never root keys. In the owner credential card paste
access key ID, secret access key and region. The `app-credentials` card serializes the bundle
into existing sealed `ConnectIntegrationToken.plaintext`; secrets never enter assistant tools.
Server composition supplies region and a lowercase ASCII verified domain (punycode supported).
R1 supports standard AWS partition endpoints, not China, custom/FIPS or dual-stack endpoints.
Create the identity/DNS records and request production access manually in the AWS console.

Minimal R1 IAM policy (replace REGION, ACCOUNT_ID and DOMAIN):
```json
{"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":"ses:GetAccount","Resource":"*","Condition":{"StringEquals":{"aws:RequestedRegion":"REGION"}}},
  {"Effect":"Allow","Action":"ses:GetEmailIdentity","Resource":"arn:aws:ses:REGION:ACCOUNT_ID:identity/DOMAIN","Condition":{"StringEquals":{"aws:RequestedRegion":"REGION"}}}
]}
```
Root and IAM access-key formats overlap; the schema cannot attest principal ownership.
The credential broker must bind the sealed credential to the owner/workspace/connection.
No AWS ambient credentials, STS, SDK, credential cache or automatic retries are used.

[GetAccount](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_GetAccount.html) reports
actual regional quotas. [Sandbox](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html):
verified recipients only, 200/day, 1/second; production access is regional.
[Unlimited quota](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendQuota.html):
`max24HourSend: -1` returns `remaining24HourSend: "unlimited"`; rate and usage remain separate.
[Identity](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_GetEmailIdentity.html) exposes DKIM tokens;
configure DNS yourself. Missing/unknown verification or DKIM evidence leaves domainReady false.
[Pricing](https://aws.amazon.com/ses/pricing/) checked 2026-10-24: à-la-carte outbound $0.10/1,000;
Essentials first 10M/month $0.16/1,000; applicable data, SNS and optional services cost extra.
No price estimate or spending authority is inferred from a plan name.

Integrator NEEDS: resolve exact @jini-ai/platform@0.6.12 and lockfile; add this non-workspace
plugin to root om:build-plugins. Wire broker/gateway in
`apps/server/src/composition/{agent-plugin-backends,workers,index,identity}.ts`, integration
binding in `apps/server/src/integrations.ts`, and tool parity in `apps/server/src/om-tool-coverage.ts`.
Gateway must recheck admission, connection and scope on each dispatch and audit context IDs.
Run tests/contract-suite.ts over both real broker/gateway adapters using synthetic fetch.
DS2 owns credential/status UI; integrator closes HTTP/MCP/CLI bindings.

Deferred sends share Resend's ONE server policy, exact bulk card and jobs outbox. Freeze final
payload/recipient snapshot; recheck contact binding, erasure, suppression and marketing consent
at every dispatch. Transactional intent requires a trusted approved purpose. Require working
HTTPS unsubscribe footer, List-Unsubscribe and List-Unsubscribe-Post; POST appends withdrawal
without login, GET does not withdraw. SES has no documented send idempotency token: durable
delivery-key/digest/dispatch records belong to the host; ambiguous outcomes require reconciliation.
R2/later: resolved sends, batch/segment orchestration, configuration-set/SNS checks, authenticated
feedback ingress, durable event dedupe, suppression and unsubscribe linkage. Tracking stays off.
No plugin-owned persistence, approval engine, vendor contacts, provisioning or DNS writes.

Verification: tests are written, not run; no builds/checks/installs/indexing. Run the lane's
typecheck directly: `corepack pnpm --dir content/agent-plugins/amazon-ses typecheck`.
R1 execution: `cd content/agent-plugins/amazon-ses && corepack pnpm typecheck` ran once;
exit 2, sole diagnostic TS2307: @jini-ai/platform unresolved. No installs or rerun.
Scope basis: `ADS-memory/.local-artifacts/codex-runs/2026-10-24-plugin-amazon-ses/R1-prompt.md`
explicitly restricts R1 to reads/auth. Its final owner directive approves plan.md without a
separate plan review; review.status is `skipped` and review.md is absent. No missing cuts
or broader sending approval are inferred. Scope remains the two read commands only.

R1F adds synthetic regressions for unlimited/exhausted/invalid daily quota and midstream
body failure with/without caller cancellation. A cancelled body read reports `cancelled`;
an expired request deadline reports `unavailable`. Unknown vendor facts grant no readiness
or sending authority. Real broker/gateway shared-suite execution remains an integrator NEED.
R1F typecheck ran once with the same command above: exit 2, sole diagnostic TS2307 at
`src/transport.ts:2` for missing `@jini-ai/platform`. No test/build/install or rerun occurred.
