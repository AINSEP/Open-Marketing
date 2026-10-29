# Vendor-neutral design (BINDING), 2026-10-27

Status: binding for the vendor-neutral Codex wave. It supersedes the "design note" and job table in
`.local-artifacts/codex-runs/2026-10-27-a-vendor-neutral/report.md`. Reviewer: Opus 5.5 (read-only review; no tests run).
Every brief appends `development/COMMON.md` unchanged and cites this file.

**Core idea.** The plugin ABI already exists. It is just named after vendors.
- About 20 ad plugins already export `translateCampaign`, `campaignDeploymentPlanSchema`, `deployCampaignPaused` and `readCampaignDeployment`.
- Resend and SES already implement Jini's published `MailProviderModule` (`@jini-ai/platform/mail`).
- LinkedIn, Pinterest and Microsoft already export conversion backends.
- `createCapabilities` plus `capabilityCatalog` already exist.

The fix is to standardize these **fixed export names**, using the standard `PluginCapabilityDependencies`. The host then calls those names and never branches on plugin ID. Very little new ABI is added.

## 1. Findings verdict

| # | Verdict |
|---|---|
| 1 dispatcher maps/switches | **Confirmed** (`agent-plugin-backends.ts` 285, 569-612, 679, 646, 722, 804-896). Phase A. |
| 2 Google developer token / Meta configId | **Confirmed**. The Microsoft plugin calls `credentials.access({connectionId:"developer-token.microsoft-ads"})`, which the host refuses twice (connection mismatch, then the `developer-token.` deny), so Microsoft is broken today. Phase A. |
| 3 closed provider enum/catalogue | **Confirmed**. Phase B. |
| 4 OAuth lists + Meta exchange | **Confirmed**. Phase A covers discovery only: lists, enum, guidance text, configId. The Meta GET exchange and debug_token code moves in Phase C (documented temporary exception). |
| 5 conversion pinned to linkedin-ads | **Confirmed**. Phase A. The plugin comes from `grant.destination`. |
| 6 deploy/stop ID lists, apiVersion, LinkedIn draft inference | **Confirmed**. Phase A. |
| 7 model wire/auth/routes/defaults | **Confirmed**. Phase B. The protocol-level code is a Jini gap (see §2.6). |
| 8 usage parsing/prices | **Confirmed**. Phase B. Prices become plugin data; protocol parsing is a Jini ask. |
| 9 Studio integrations | **Confirmed**. Phase A. |
| 10 Sharp in catalog.ts | **Legitimate exception.** Sharp is a local codec library, chosen at the composition root behind the existing `ImageInspectionPort`/`ImageTransformPort`. That is already DI. Jini ask: add `limitInputPixels`/timeout options to the `@jini-ai/cms/media/node` Sharp adapter, then drop OM's `import type { Sharp }`. **No sharp-media plugin.** |
| 11 picker map | Confirmed. Phase B. |
| 12 canvas label prefixes | Confirmed, low. Phase C. Use `receipt.pluginId` → `AddonSummary.name`. |
| 13 `sk-` display guard | **Legitimate exception.** It is a generic defence-in-depth secret-text heuristic (many vendors use `sk-`), not a selection. **S01 cut.** |
| 14 site-guide path | Confirmed. Phase C. om-playbook already declares `provides:["site-guide"]`; boot reads the guide from the enabled plugin that declares it. |
| 15 boundaries SDK regex | Confirmed, low. Phase C. Keep the deny-list until a structural rule replaces it. |
| 16 coverage metadata | Confirmed, low. Phase C. |
| 17 Meta seed consent | Confirmed. Phase C. Use target `sandbox-measurement`; existing published rows stay unchanged. |
| 18 core tests import plugin source | Confirmed. Phase C. |

## 2. Interfaces (minimal; data types are Zod-derived and live in `packages/contracts`)

### 2.0 Primary test: which Jini/Tovu pattern each interface copies

Sources:
- tovu-45 pointers: `.local-artifacts/codex-runs/2026-10-27-a-jini-patterns/tovu-45-pointers.md`;
- the Codex study `…/2026-10-27-a-jini-patterns/report.md` (landed 10-27; the five rows marked "Revision 10-27" were resolved against it by open-marketing-38).

**UNCONFIRMED** means I could not verify the source myself, and the revision pass must check it against the study.

| Interface | Copies | Status |
|---|---|---|
| Mail sender (§2.2) | Jini `MailProviderModule`, `createMailProviderRegistry`, `MAIL_PROVIDER_SETTING_KEY`, `resolve-mailer` (0.6.12); Tovu `mail-adapter-registry.ts` + `tovu-mail-adapters.json` | confirmed (read `provider.d.ts` and Tovu registry/json) |
| Credential cards, plugin secrets (§2.1) | Tovu `credentialCards` in plugin.json + `features/agent-plugins/credential-cards.ts`/`access-token-tool.ts`. OM already uses this card shape. | Cards confirmed. **Revision 10-27: `plugin-secret` + `access().secrets` CONFIRMED as an OM-local gap fill.** The study: Tovu mail/analytics resolve plugin-level secrets by declared credential *label* (`credentialKeys`), which it calls a convenience, not an ownership boundary; Jini has no arbitrary-field scoped secret port. Do NOT copy label lookup. OM binds to the invocation's plugin ID (as designed). Jini ask (additive, opt-in): a call-scoped declared-field resolver bound by host-established plugin/workspace identity and secret revision; OM swaps to it when published. |
| OAuth (§2.1, Phase C) | `@jini-ai/oauth` 0.6.12 (`registration.ts`, `token-endpoint.ts`); Tovu `tovuAuthMode`, `google-login/tovu-login-providers.json` | Jini confirmed. **Revision 10-27 (Phase C only):** Tovu declares OAuth connections in a data file (`google-workspace/tovu-connections.json`) validated by Jini's published `parseApiConnectionDescriptor`, with plugin `lib/auth.mjs` `createHooks` for provider quirks; the host keeps client, state, callback and storage. Phase C copies that: Meta's exchange/debug_token becomes Meta's *hooks* under a Jini descriptor, replacing the proposed `createOAuthExchange` export. Jini has no seam for non-standard exchange steps, so if the hooks can't express Meta's GET exchange, file a narrow Jini ask. Phase A (discovery by `oauth.json` presence) is unaffected. |
| Model providers (§2.7) | Jini `runProviderToolTurn`/`ProviderTurnAdapters`, `ModelCatalogCache`, `model-discovery` (agent-runtime 0.6.12), protocol `agent-catalog.ts`; Tovu `assistant/agents.ts`, `live-model-cache.ts` | Adapters and cache confirmed. **Revision 10-27: still open, deferred to B0 (Phase B; not tonight).** The study did not cover `agent-catalog.ts`. B0's plan must read the installed `@jini-ai/protocol` 0.6.12 agent-catalog declarations and shape `modelProvider` entries to match. Candidate discovery: the study says Jini's published `createProviderRegistry`/`defineProviderContribution` (and mail's `registry.list()`) is the pattern, so B0 should list model candidates from a provider registry like mail does, not from `provides:["model"]`; drop `"model"` from §3 if B0 confirms. Copy the adapters and cache, NOT Jini's fixed `listProviderModels` protocol branches or Tovu's branded fallback aliases (study §4). Pricing: none in Jini or Tovu, so it stays OM plugin data. |
| Generic plugin tools (§2.4) | Jini `@jini-ai/agent-plugins/lifecycle/tools` 0.6.12 (`AgentPluginToolDescriptor`, `defineAgentPluginToolContribution`, `createAgentPluginToolProjection`); Tovu `executable-tools/register.ts` | **Revision 10-27: checked, NOT adopted wholesale.** Tovu does run plugin tools in-process, through Jini's tool contribution (data file plus contained `.mjs` modules). OM can't take it as-is: (a) Jini's `effect` is `read/write/destructive`, but OM's safety gates need effect categories (`spend`, `halt_stop`, …), `moneyExposure` and daily limits; (b) Jini executable contributions are admitted only at bundled digests, which the study flags as wrong for OM's install model; (c) its capabilities handle is Tovu-shaped (`getAccessToken`), not OM's fenced `PluginCapabilityDependencies`. So keep `pluginToolSchema`, but A0 must align field names with `AgentPluginToolDescriptor` (`name`, `description`, `inputSchema` as JSON Schema) so a later move is a rename. Jini ask: extensible effect categories on tool descriptors. |
| Deploy/stop/conversion ABI (§2.5, §2.6) | none (OM-specific marketing domain); generalizes OM's own de-facto exports | No Jini equivalent expected; OM-specific under the Jini gap rule |
| Provider selection storage (§3) | Jini `ProviderRegistry` + keyed setting (mail) | Mail confirmed; the `om_owner_settings` KV is OM-local |
| Image codec | none. Tovu imports sharp directly; Jini has no codec port. | OM keeps its existing `ImageInspectionPort`/`ImageTransformPort` (finding #10 exception). Jini ask: codec port + Sharp limits. |
| Trackers / analytics | Jini diagnostics `ObservabilityPort`/`ProductAnalyticsPort` + `@jini-ai/provider-plugins` (release line only, not on npm) | Out of scope; OM waits for publish. No OM tracker interface. |

### 2.1 Plugin credentials: no `PluginSecretsPort`, no `credentialCards[].scope`

Both are cut. `PluginCapabilityDependencies.credentials.access` widens its result:

```ts
access(required: { connectionId: string; accountId: string | null }, optional?: CallOptions):
  Promise<Outcome<{ accessToken: string; expiresAt?: number; secrets?: Readonly<Record<string, string>> }>>;
```

- `secrets` holds only the values of `secretFields` that the **executing** plugin declares on its own `plugin-secret` card.
- They are read from sealed record `plugin-secret.<pluginId>`, where `pluginId` is the bound invocation's ID and never comes from plugin input.
- The keys are filtered to the declared names.
- Google and Microsoft both read `credential.secrets?.developerToken`. That is two real consumers.

Card change: `saveKind` replaces `'developer-token'` with `'plugin-secret'`. One record per plugin holds all of its plugin-secret fields. Vendor format checks such as the 22-character rule live in the plugin only.

Contract changes:
- `pluginSecretQuerySchema = z.strictObject({ pluginId: idSchema })`;
- `pluginSecretSetSchema = pluginSecretQuerySchema.extend({ values: z.record(fieldName, z.string().min(1).max(8192)).nullable() })`;
- `pluginSecretStatusSchema = z.strictObject({ configured: z.boolean() })`;
- delete `developerToken*`;
- move `cardSchema` and `credentialPluginStatusSchema` from `apps/server/src/integration-credential-cards.ts` into `contracts/addons` unchanged, except that `saveKind` gains `'plugin-secret'` and loses `'developer-token'`. This lets Studio parse cards without vendor unions.

`loginCustomerId` is no longer host-owned. It is removed from `hostOwned` and reaches Google as `configuration.settings.loginCustomerId`, and the plugin validates it.

OAuth-client extra fields (Meta `configId`): the oauth-client card's declared `fields` become the extra client keys. The client is `{ clientId, clientSecret?, ...declaredFields }`, with string values up to 2048 characters. The server passes `clientFields: readonly string[]` to credentials. The `metaClientSchema` branch is deleted.

Existing local `developer-token.google-ads` rows are not migrated; the owner re-enters them. This follows the no-live-migration rule.

### 2.2 Mail: `email.send.v1` cut; copy Tovu's mail-adapter pattern on Jini mail

This copies Tovu `apps/website/src/features/agent-plugins/mail-adapter-registry.ts` and `content/agent-plugins/resend/tovu-mail-adapters.json`.

**Declaration.** The plugin declares its mail adapters in its OM manifest extension:

```ts
mailAdapters: [{ id, label, module, credentialKeys, feedback }]
```

This is Tovu's `schemaVersion: 2` descriptor. The module's default export is a Jini `MailProviderModule` (`@jini-ai/platform/mail`).

**Host side.** Following Tovu `contributeMailProviders`, the host:
- loads the declared module through the same revision/admission fence as other plugin code;
- contributes it to Jini `createMailProviderRegistry()`, which runs `validateMailProvider`; refusals are recorded and never crash boot;
- supplies the per-call credential and a guarded `httpClient` through Jini's `MailProviderCallContext`.

**Gating.** OM's gate wraps the send. That gate is notification authority plus the reservation cap plus admission/revision rechecks, and it follows Jini `resolve-mailer`/`delivery-wrapper`.

**Plugin authority callback.** The plugin-side `authority` callback is dropped if the host gate holds through egress. A2d's plan must confirm this against `resolve-mailer.ts`.

**Implementations.** Resend and SES. Install configuration (domain, From address, SES region/SNS) comes from plugin install settings.

**Selection.** Jini `MAIL_PROVIDER_SETTING_KEY` with `MailProviderSetting {transactional, bulk}`; status from `computeMailStatus`; candidates from `registry.list()`. Mail does not use `provides`.

### 2.3 Messaging: `message.send.v1` cut

No core caller sends messages; Twilio and WhatsApp are assistant tools only. They use the generic tool ABI (§2.4). Revisit when a core caller exists.

### 2.4 Generic plugin tools (replaces `zodToolExports`, `pluginCommand`, `googleContributions`, `contributions`, the `executePlugin` switch)

```ts
export const pluginToolSchema = z.strictObject({ name: idSchema, description: z.string().min(1).max(4096),
  inputSchema: z.record(z.string(), z.json()), effects: z.array(effectCategorySchema).min(1).max(10),
  connectionOnly: z.literal(true).optional(),            // read-only tools with accountId null (replaces Meta instagram_accounts branch)
  unavailableReason: z.string().max(200).optional() });  // replaces the google-ads unavailable() branch
export type PluginTool = z.infer<typeof pluginToolSchema>;
export type PluginToolInvocation = { context: CallContext; connection: { connectionId: string; accountId: string | null };
  name: string; operationId: string; input: unknown; moneyExposure: MoneyExposure | null; requiredLimit: DailyLimitRequirement | null };
export type PluginToolsFactory = (required: PluginCapabilityDependencies) =>
  { invoke(required: PluginToolInvocation, optional?: CallOptions): Promise<Outcome<unknown>> };
/** Pure helper for Zod-based plugins: JSON Schema + parser from Zod tools. */
export function definePluginTools(required: { tools: readonly { name: string; description: string; effects: EffectCategory[]; inputSchema: z.ZodType }[] }):
  { tools: PluginTool[]; parseTool(required: { name: string; input: unknown }): Outcome<unknown> };
```

Module exports are `tools`, `parseTool` and `createTools`.
- The host rejects `connectionOnly` unless effects are exactly `['read']`.
- Effects stay floors and never confer authority.
- Vendor API versions and binding IDs (LinkedIn `202610`, Meta `v25.0`) move into the plugins.

### 2.5 Campaign lifecycle: no new IDs except halt-stop

**Deploy:** the reserved `campaign.deploy` and `campaign.validate.v1` stay reserved and are not completed. The existing de-facto exports become the ABI:
- `translateCampaign`;
- `campaignDeploymentPlanSchema` (Zod);
- `deployCampaignPaused(required)`;
- `readCampaignDeployment(required)`.

```ts
required = { context; operationId; plan; connectionId; accountId; dependencies: PluginCapabilityDependencies;
  checkpoint(input: { step: string; phase: string; references?: unknown; record?: unknown }): Promise<Outcome<void>>;
  saved: { references: Record<string, string>; record: unknown | null } }   // record = latest opaque checkpoint (Google journal)
export const campaignDeploymentReceiptSchema = z.object({ status: z.enum(['acknowledged', 'unknown']),
  state: z.enum(['paused', 'draft']), entityIds: z.array(idSchema).max(500),
  references: z.union([z.array(idSchema).max(500), z.record(idSchema, idSchema)]).optional() }).passthrough();
```

`state` replaces the `vendor_linkedin_ads_` prefix inference. Google wraps its `createGooglePlugin` journal behind these two functions and exports a Zod plan schema.

**Stop:** keep `campaign.halt-stop.v1` in `capabilityCatalog`:

```ts
{ requiredEffects: ['halt_stop'], input: haltStopRequestSchema,
  output: z.strictObject({ status: z.enum(['acknowledged', 'unknown']), entityIds: z.array(idSchema).max(100) }) }
```

- Implementations: Google, LinkedIn and TikTok (three).
- The host runs it only from the halt worker, with `stopPermit` set, through the existing `capabilityCall` path.
- `invokeCapability` keeps refusing non-read capabilities.
- Meta has no handler, so the generic "no stop capability" failure applies.

### 2.6 Conversions: `conversion.deliver/reconcile.v1` cut

- Fixed export `createConversionDelivery(required: PluginCapabilityDependencies & { authority })`, returning measure's existing `ConversionDeliveryPort` shape.
- Rename the existing LinkedIn, Pinterest and Microsoft factories; that gives three implementations.
- The plugin ID comes from `input.grant.destination`, which is owner-approved.
- There is no new contract type: the host keeps its `Factory<Required<ConversionDeliveryPort>>` assertion, and each plugin's conformance test asserts the structure.

### 2.7 Model providers (Phase B): `ModelProviderPort` and native-code provider plugins cut

Jini 0.6.12 already provides:
- `runProviderToolTurn`/`providerTurnAdapters` for protocols `anthropic|openai|azure|google` (`ProviderProtocol`);
- `ModelCatalogCache`.

It has no pricing, no normalized usage and no published live model listing (`listProviderModels` exists in `dist/providers/model-catalog` but is not exported).

So:
- **Data-only provider plugins.** `content/agent-plugins/{anthropic,openai,google}` contain `plugin.json` only. They keep today's IDs so saved connections still resolve. Each has an api-key card, `provides:["model"]` and a `modelProvider` declaration:
  ```ts
  modelProviderSchema = z.strictObject({ protocol: z.enum(['anthropic','openai','google','azure']), endpoint: httpsOrigin, label,
    models: z.array(z.strictObject({ id: idSchema, label, efforts: z.array(z.strictObject({ id: idSchema, label, request: z.record(z.string(), z.json()) })).max(8),
      pricing: z.strictObject({ inputUsdPerMTok: decimal, outputUsdPerMTok: decimal, cachedInputUsdPerMTok: decimal.optional(),
        cacheWriteUsdPerMTok: z.record(idSchema, decimal).optional(), source: z.url(), observedOn: isoDate }).optional() })).min(1).max(64) })
  ```
  - `efforts[].request` is a declared body fragment that is deep-merged by the host. It replaces `providerRequest`'s per-vendor effort code and Google's thinkingBudget table.
  - A model without pricing means unknown cost, never zero.
- **Contract changes.**
  - `assistantProviderSchema = idSchema`;
  - runtimes max 32, models max 64;
  - `assistantContextSchema` gains server-derived `protocol`, so the agent passes `protocol` and not `provider` to `runProviderToolTurn`;
  - the broker route becomes `/api/agent/v1/model/:providerId/*`, and the suffix must equal the protocol path for the frozen model. This removes the hard-coded `gemini-2.5-flash` path.
- **Protocol-level code** (request schemas, auth header, usage-frame capture, terminal frame, cache inclusivity) stays in **one** core file `apps/server/src/model-protocols.ts`, keyed by Jini `ProviderProtocol`. It is a listed exception: protocol, not vendor. **Jini ask:** publish `providerWire(protocol)` → `{ authHeaders(apiKey), requestSchema, captureUsage(frame) → normalized {input, output, cachedRead, cacheWrite:{[k]:n}, reasoning, inclusive}, isTerminal(frame) }`, and export `listProviderModels`. Delete the OM copy when it ships.

### 2.8 Rejected or kept proposals

| Proposal | Decision |
|---|---|
| `email.send.v1` | cut (Jini mail + Tovu adapter declaration) |
| `message.send.v1` | cut (no caller) |
| `campaign.halt-stop.v1` | **kept** |
| `conversion.*.v1` | cut (fixed export) |
| `credentialCards[].scope` | cut (`saveKind:'plugin-secret'`) |
| `PluginSecretsPort` | cut (`access().secrets`) |
| manifest `oauth.*` | cut. Keep each plugin's existing `oauth.json`; discover it by presence. Meta's challenge rules move into its `oauth.json` in Phase C. |
| manifest `modelProviders` | **kept** as a singular `modelProvider` |
| `ModelProviderPort` | cut (Jini ask) |
| new provider plugins | **kept** as data-only |
| sharp-media plugin | cut |
| S01 detector port | cut |

## 3. Selection

Candidates for a provider slot come from different places:
- **Mail:** from Jini's mail registry, following Tovu (§2.2).
- **Models and site guide:** from the existing host-owned `provides: string[]` (om-playbook already uses `"site-guide"`), with the new value `"model"`. This is UNCONFIRMED against Jini `agent-catalog`.

- **Multi-instance seams** (ad tools, capabilities, deploy, stop, conversions) need no selection. The caller already names the plugin: tool name, `target.pluginId`, the stop job's `pluginId`, `grant.destination`.
- **Singleton seams** use an explicit owner setting, never "the first one installed":
  - Mail: key `mail.provider` (Jini) holds `MailProviderSetting`, stored in new table `om_owner_settings(owner_id, workspace_id, key, value_json, PK(owner_id, workspace_id, key))`. The table goes in the **unshipped** `0006_alerts.sql`.
  - Model: the existing `om_assistant_settings` (provider + connection + model + effort).
- **None installed or selected:** mail reports Jini `unconfigured`, and the alert job fails with retryable `unavailable` / `sender_not_bound`. Retryable means it can be re-queued once a sender is set (this is the r3-alert-resend item 3 fix). The model falls back to sandbox mode, with status `unavailable` for model mode. Default settings become `{ mode:'sandbox', model:'sandbox', connectionId:null }`.
- **Several installed:** the owner must choose, and the UI lists the `provides` candidates. Inside a chosen provider, a single saved connection auto-resolves; this keeps today's `readiness` rule.
- **Selected but disabled, unadmitted or uninstalled:** fail closed with the same refusal, and never fall back to another provider.

## 4. Authority (unchanged; restated as acceptance criteria)

- A declaration (`provides`, cards, tools, `modelProvider`) never grants authority.
- Effects are floors; spend still requires the dispatcher permit.
- Every dispatch rechecks enabled, admitted and revision (`executableRevision`), binding (`bindingCurrent`), halt and campaign authority immediately before egress. This covers the existing `guardedFetch`/`credentials` fences and the new mail and halt-stop paths.
- Secrets go only to the declaring plugin's bound invocation. They never appear in tool arguments, status, logs or errors.
- Plugin-secret and oauth-client records remain unreachable through `access()` as connections.
- The server invoker is still the only approval gate. Mail keeps notification authority, the reservation cap of 20 per day, and uncertain-outcome handling. Conversions keep measure's consent, grant, subject-lane, account-lock and outbox checks.

## 5. Phases

**NEEDS before Phase A:**
- The in-flight r3 owners must release `agent-plugin-backends.ts`, `features/credentials`, `packages/contracts`, studio `pages/addons` and the plugin directories below.
- **r3-microsoft-server** is superseded, by A1 + A3 + A2a. Discard its plan.
- **r3-alert-resend** (held) is replaced by A6, which uses its brief's items 2–5 but with Jini mail selection instead of a Resend binding.

### Phase A: plugin and integration neutrality (11 jobs: A0–A7, with A2 split into a–d; Codex plan → Claude trim → implement)

| Job | Deps | Exclusive lane | Deliverable |
|---|---|---|---|
| **A0 contracts** | — | `packages/contracts/**` | §2.1 secret/card schemas (move the card schemas in), widened `access` result, §2.4 tool ABI + `definePluginTools`, §2.5 receipt schema + deploy types + `campaign.halt-stop.v1`. |
| **A1 credentials** | A0 | `features/credentials/**` | `plugin-secret.<pluginId>` purpose and reader; `clientFields` for oauth-client; delete the Google/Meta branches and `developer-token` checks (`token.ts`, `broker.ts`, `sql.ts`, `jini-oauth-common.ts`). |
| **A2a google+microsoft** | A0 | `content/agent-plugins/{google-ads,microsoft-ads}/**` | Fixed exports (§2.4, §2.5); `secrets.developerToken`; `loginCustomerId` from settings; `plugin-secret` card; Google halt-stop capability; Microsoft `createConversionDelivery` rename. |
| **A2b meta+tiktok** | A0 | `content/agent-plugins/{meta-ads,tiktok-ads}/**` | Fixed tool and deploy exports (Instagram command wrapping and `v25.0` move inside); TikTok halt-stop; OAuth/paste guidance in card text; Meta oauth-client card declares the `configId` field. |
| **A2c linkedin** | A0 | `content/agent-plugins/linkedin-ads/**` | `definePluginTools`, deploy receipt `state:'draft'`, halt-stop capability, `createConversionDelivery`; `apiVersion` and binding IDs move inside. |
| **A2d mail+messaging** | A0 | `content/agent-plugins/{resend-email,amazon-ses,twilio-sms,whatsapp-business}/**` | Declared `mailAdapters` with a default-export Jini `MailProviderModule` (Tovu pattern, §2.2); Twilio/WhatsApp `definePluginTools` + `createTools` (gateway pass-through removed; deadline built from `wait`). |
| **A3 dispatcher** | A0, A1, A2a–d | `apps/server/src/composition/agent-plugin-backends.ts` + its test | Delete every plugin-ID branch and map; call the fixed exports. Also: attach declared secrets; conversion plugin = `grant.destination`; halt-stop via capability; deploy with standard deps, `saved`, `receipt.state`. Add a guarded `mail({ context, pluginId, request })` send with the same fences. |
| **A4 integrations host** | A0, A1 | `integrations.ts`, `integration-credential-cards.ts`, `inbound/integrations.ts`, `cli/addons.ts`, `cli/http.ts`, `addon-tools.ts`, `integration-oauth-contracts.ts` (`oauthClientQuerySchema` → `idSchema` only) + their tests | `/integrations/plugin-secret` HTTP/CLI/tool; `actionSupported` from declarations and registered OAuth metadata; delete the vendor lists and TikTok/Meta guidance strings. |
| **A5 alerts + selection** | A3, A2d | `apps/server/src/alerts/**`, `composition/workers.ts`, `migrations/0006_alerts.sql`, new `inbound/provider-settings.ts`, `tests/alerts-jobs.test.ts` | `om_owner_settings`; GET/PUT `mail.provider` with Jini mail-registry candidates (Tovu `contributeMailProviders`) and `computeMailStatus`; worker sends through `backends.mail`; re-queue fix; stop payload `pluginId: idSchema`. |
| **A6 studio integrations** | A0, A4, A5 | studio `pages/addons/**`, `shared/api/{types,validation,http,sample}.ts` | Render cards generically, including plugin-secret and oauth-client fields; mail-provider select; delete vendor unions, the Google developer-token page and the Meta field. Keep `sk-`. |
| **A7 composition** (integrator) | A3–A5 | `composition/index.ts`, `composition/serve.ts`, `apps/server/package.json` | Discover `oauth.json` from installed plugins (delete the 3-ID list); wire provider-settings and mail. The Meta `challengeRules`/bindings wiring is left as-is until Phase C. |

A2a–A2d can run in parallel, and A7 is integrator-only.

**Revision 10-27 (open-marketing-38), binding on the job briefs:**
- **Credit-short order.** The earlier "A0 → A1 → A2a → A3 → A4 first" set was invalid: A3 deletes every vendor branch at once, so it needs all of A2a–d, or Meta, TikTok, LinkedIn, mail and messaging stop working. The self-contained first batch is **A0 → A1 → A2a** (then A4, which needs only A0 + A1). A3 runs only after A2b–d land.
- **Additive-first contracts.** A0 *adds* the new schemas and types and leaves `developerToken*` and `saveKind:'developer-token'` in place, marked deprecated. A1, A3, A4 and A6 stop using them, and A7 deletes them. That keeps every package compiling at each job boundary, so a credit cut-off mid-wave never leaves the tree broken.
- **Alerts job label.** The alerts and selection job is **A5** (this table). The NEEDS line above saying "A6" means A5.
- **Tool ABI field names** follow Jini `AgentPluginToolDescriptor` (see the §2.0 revision).
- **Trim findings that bind later jobs:**
  - **A4 lane gains** `integration-oauth-vendors.ts`. After A1, oauth-client extra fields such as Meta `configId` are read only when the caller passes `clientFields`. Until A4 passes the card-declared fields at integrations.ts:71/:159 and integration-oauth-vendors.ts:62, the Meta OAuth exchange returns `unavailable`. This is a local, uncommitted window; A4 runs right after A1. A4 also owns the early `plugin-secret.` refusal in `access()` (integrations.ts:101/:236) and switches the server to the contracts `cardSchema`, deleting integration-credential-cards.ts:14-49.
  - **Plugins keep their `developer-token` cards until A4.** The server's local `cardSchema` rejects `'plugin-secret'` and would drop the plugin's whole card list. A2a changes plugin code only; the plugin.json card swap follows A4.
  - **No plugin.json declares `campaign.halt-stop.v1` until A3 filters non-read IDs.** Otherwise it becomes an approval-dispatcher assistant tool (agent-plugin-backends.ts:135-152). The handlers inside `createCapabilities` are fine.
  - **New job A2a-tools, right before A3:** Google `tools`/`parseTool`/`createTools` (A2a review FIX 5 and FIX 6). It was deferred from A2a because the server's `googleContributions` calls `tools({})`. A2a also keeps transitional top-level `developerToken`/`loginCustomerId` fallbacks; A3 removes them when the host attaches secrets.
  - **Revision 10-28 (A2d trim): mail `mailAdapters` DEFERRED to a new job A2d-mail, after A3.** No host gate holds through egress yet (no resolve-mailer in OM or Jini 0.6.12; the guarded host `mail()` send is A3's, the worker send A5's), so the plugin `authority` callback stays for now. Also, a dependency-free default `MailProviderModule` gets no clock (B7) and no install settings (SES region/rate/SNS, Resend domain) on 0.6.12. Default: send Jini ask "injected `now` + install settings in the mail create context / `MailAdapterKit`" (SES and Resend both need it, rule-of-two); fallback is an OM-local rule that `mailAdapters[].module` default-exports a DI factory `(deps) => MailProviderModule`. A3 must keep the existing mail factories working until A2d-mail lands. Twilio/WhatsApp tools land in A2d as planned.
  - **Revision 10-28 (hot-server trim):** `stopPayloadSchema` in composition/workers.ts:20 hard-codes `z.enum(['google-ads','linkedin-ads','tiktok-ads'])`; A5's row already says `pluginId: idSchema` — A5 (or A3, whichever lands first) must do it.
  - **Revision 10-28 (A4 trim):** the plugin-secret status tool is held back from A4 because om-tools.ts was busy; the Coordinator adds the om-tools.ts + om-tool-coverage.ts lines after oe-owner-presentation lands. A4 has NO set/clear secret tools (design §4: secret values never appear in tool arguments).
  - **Revision 10-28 (A2b trim):** (1) Meta/TikTok `deployCampaignPaused`/`readCampaignDeployment` accept BOTH the old host shape (`{dependencies:{admitted, dispatch|egress}, references}`, agent-plugin-backends.ts:887-895) and the new one, marked `// transitional: remove in vendor-neutral A3`; a plugin-lane cleanup job must remove them right after A3 (A3 can't touch plugins). (2) LIKELY LIVE BUG for A3: the host passes the whole call object into TikTok `egress.send` (agent-plugin-backends.ts:~862) and the plugin's strict input schema (transport.ts:15) rejects the extras, so TikTok tools and halt-stop probably fail today (unverified, no tests run). (3) A0 lets tool calls carry a null account while plugin configuration/credential lookup require one; default: null only for account-discovery tools. (4) A4 deletes the core Meta/TikTok guidance strings (integrations.ts ~:157, ~:198) — the cards now carry the text.
  - **Revision 10-28 (A2c trim) — SETTLED open question:** LinkedIn conversion install configuration lives in the generic plugin key `settings.conversionConfiguration` = `{accountId, purpose, payloadSchema, conversionRules}`; the plugin checks the account match and uses its own ID as destination; no `mode` (the host already blocks non-production). A3 core changes (NEEDS): stop stripping `conversionConfiguration` (agent-plugin-backends.ts ~:197-198), delete the host's own read/account check (~:467-468), choose the plugin from `grant.destination` instead of the `'linkedin-ads'` literal (~:458). Microsoft `customerId` comes per call from Microsoft's existing `Account/Query` ParentCustomerId lookup (microsoft capabilities.ts ~:57-62) — no core change; a Microsoft follow-up job. LinkedIn keeps transitional exports (`createLinkedInAdsAdapter` strict config, old-shape `deployCampaignPaused`, `createLinkedInCapiBackend`, `linkedinAdsTools`) marked `// transitional: remove in vendor-neutral A3`.
  - **Revision 10-28 (e1, Jini 0.6.15-rc.1):** the rc does NOT include the mail create-context `now`/install settings ask. A2d-mail therefore takes the FALLBACK: `mailAdapters[].module` default-exports an OM-local DI factory `(deps) => MailProviderModule`. The Jini ask stays OPEN with tovu-45 (rule-of-two: SES + Resend; jini-gap-rule); when Jini ships it, a follow-up switches A2d-mail to the Jini mail context and deletes the factory convention.
  - **Revision 10-28 (e1, later):** tovu-45 put the mail create-context `now`/`settings` into Jini 0.6.15-rc.2 (ETA hours). So A2d-mail now lands only the contracts `mailAdapters` descriptor and the plugin.json declarations; the module default-export targets the Jini mail context once rc.2 is installed. The OM-local DI factory is NOT built.
  - **Revision 10-28 (A2c trim) — LIVE BUG, fixed in A2c:** LinkedIn's stop check hashed `{adAccountId, entityIds, action}` in insertion order (`linkedInDigest` = plain JSON.stringify, commands.ts:173; transport.ts:124) while safety's `digestArguments` hashes sorted-key JSON (features/safety/src/rules.ts:21-36), so every safety-issued LinkedIn stop returned `conflict`; the plugin test hid it by reusing the plugin's own digest. Check every other plugin's stop/argument digest for the same mismatch (wave-2 audit item).
  - **Open, settle with A2c:** where conversion install configuration (`conversionConfiguration` is host-owned and stripped from settings) and `customerId` come from under `createConversionDelivery(PluginCapabilityDependencies & { authority })`.
  - **A1 keeps the old developer-token entry points** as thin wrappers writing `plugin-secret.<pluginId>`, so the server's current set, status and resolve paths keep working until A3/A4.

### Phase B: model providers (4 jobs)

- B0: contracts §2.7.
- B1: the three data-only plugins.
- B2: server — `models.ts` deleted; `model-protocols.ts`, `conversations.ts`, `inbound/model.ts`, `inbound/http.ts`, `model-usage.ts` use declared data; the `bindModelCredentials` default is removed.
- B3: agent + studio picker — `apps/agent/src/runtime/model.ts`, `runtime.rules.ts`, `runtime-selection.ts`; neutral preview fixtures.
- File the Jini ask (§2.7) in parallel.

### Phase C: the rest

- Meta OAuth exchange into meta-ads (`createOAuthExchange` fixed export under host-held pending/state/sealing).
- Findings #12, #14, #15, #16, #17, #18.
- The remaining ad plugins adopt the fixed exports, one cheap job per batch.
- The Jini Sharp-options ask.

## 6. Done check (after Phase A + B; must print nothing)

```sh
rg -n -i "google-ads|meta-ads|linkedin-ads|tiktok-ads|microsoft-ads|twilio|whatsapp|resend|amazon-ses|developer-?token|'anthropic'|'openai'|'google'|gemini|claude-|gpt-|facebook|graph\.facebook|\bsk-" \
  apps packages features -g '!**/tests/**' -g '!**/fixtures/**' -g '!**/*.test.*' -g '!**/*.md' -g '!**/node_modules/**' \
  | rg -v "apps/server/src/model-protocols.ts|apps/server/src/integration-oauth-vendors.ts|apps/server/src/integration-oauth-contracts.ts|apps/server/src/platform/jini-compat/db/migrations/0001_spine.sql|shared/api/validation.ts:.*secretText|cli/approval.ts:.*sk-|development/scripts/boundaries.mjs"
```

Allowed exceptions:
- `model-protocols.ts` (Jini `ProviderProtocol` names, until the Jini ask ships);
- the two Meta OAuth files (until Phase C);
- the historical spine SQL;
- the `sk-` display guards;
- the boundaries deny-list.
