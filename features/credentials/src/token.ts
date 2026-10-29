/** Paste-token ingress. Credential contents remain opaque to the feature. */
import { z } from "zod";
import { callContextSchema, connectIntegrationTokenSchema, pluginSecretSetSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome, PluginSecretSet, PluginSecretStatus } from "@open-marketing/contracts";
import type { CredentialBrokerPort, CredentialAuditPort, CredentialLockPort, CredentialRepoPort, SecretSealerPort } from "./ports.js";
import type { ConnectionSummary, CredentialReference } from "./types.js";
import { withCredentialLock } from "./locks.js";
import { boundary, failure, reservedPurposeId, sameScope, summarySchema } from "./rules.js";

const clientFieldsSchema = z.array(z.string()).max(32).refine(fields => !fields.includes("clientId") && !fields.includes("clientSecret"));
const tokenSchema = connectIntegrationTokenSchema.extend({ context: callContextSchema, purpose: z.literal("oauth-client").optional(), clientFields: clientFieldsSchema.optional() });
const clientPrefix = "om.oauth.client.v1:";
const pluginSecretPrefix = "om.plugin-secret.v1:";
const clientSchema = z.object({ clientId: z.string().min(1).max(2048), clientSecret: z.string().min(1).max(8192).optional() }).nullable();
type OAuthClientConfiguration = z.infer<typeof clientSchema> & Readonly<Record<string, string | undefined>> | null;
type TokenInput = Omit<z.infer<typeof tokenSchema>, "clientFields"> & { clientFields?: readonly string[] };
type StoredTokenInput = Omit<TokenInput, "purpose"> & { purpose?: TokenInput["purpose"] | "plugin-secret" };
type TokenDependencies = { repo: CredentialRepoPort; sealer: SecretSealerPort; locks: CredentialLockPort; audit: CredentialAuditPort };
type ReaderDependencies = { context: CallContext; pluginId: string; repo: CredentialRepoPort; broker: CredentialBrokerPort; sealer: SecretSealerPort };

/** Seal a new owner connection under the existing scoped lock; audit metadata before storage.
 * Ordinary IDs conflict; OAuth-client configuration replaces only its connected purpose record.
 * Returns a validated secret-free summary or a redacted failure; never echoes plaintext.
 * @example await connectCredentialToken({ context, connectionId, pluginId, plaintext, repo, sealer, locks, audit });
 * @complexity O(b) time/space for <=64 KiB UTF-8; a fixed number of repository operations.
 */
export async function connectCredentialToken(required: TokenInput & TokenDependencies, optional?: CallOptions): Promise<Outcome<ConnectionSummary>> {
  return boundary({ run: async () => {
    const parsed = tokenSchema.safeParse({ context: required.context, connectionId: required.connectionId, pluginId: required.pluginId, plaintext: required.plaintext, purpose: required.purpose, clientFields: required.clientFields });
    if (!parsed.success || Buffer.byteLength(parsed.data.plaintext) > 65536) return failure({ code: "invalid_input" });
    const plaintext = purposePayload({ input: parsed.data });
    if (!plaintext.ok) return plaintext;
    if (Buffer.byteLength(plaintext.value) > 65536) return failure({ code: "invalid_input" });
    const input = { ...parsed.data, plaintext: plaintext.value };
    if (input.context.principal.kind !== "owner" || input.context.principal.ownerId !== input.context.scope.ownerId) return failure({ code: "forbidden" });
    const reference = { scope: input.context.scope, connectionId: input.connectionId, version: 1 };
    return withCredentialLock({ locks: required.locks, reference, run: () => saveToken({ input, reference, dependencies: required }, optional) }, optional);
  } }, optional);
}

/** A duplicate cannot replace another plugin or restore revoked authority. @complexity O(b), fixed I/O. */
async function saveToken(required: { input: StoredTokenInput; reference: CredentialReference; dependencies: TokenDependencies }, optional?: CallOptions): Promise<Outcome<ConnectionSummary>> {
  const { input, dependencies } = required;
  const existing = await dependencies.repo.get({ context: input.context, connectionId: input.connectionId }, optional);
  if (!existing.ok) return existing;
  if (existing.value && !input.purpose) return failure({ code: "conflict" });
  const current = input.purpose ? await dependencies.repo.getSecret({ context: { ...input.context, principal: { kind: "service", serviceId: input.purpose } }, connectionId: input.connectionId }, optional) : { ok: true as const, value: null };
  if (!current.ok) return current;
  const reference = { ...required.reference, version: (current.value?.reference.version ?? 0) + 1 };
  const sealed = await dependencies.sealer.seal({ reference, plaintext: input.plaintext }, optional);
  if (!sealed.ok) return sealed;
  const audited = await dependencies.audit.record({ context: input.context, connectionId: input.connectionId, operation: "credentials.connect" }, optional);
  if (!audited.ok) return audited;
  const stored = await dependencies.repo.store({ context: input.context, reference, secret: sealed.value, pluginId: input.pluginId }, optional);
  if (!stored.ok) return stored;
  return tokenSummary({ summary: stored.value, input });
}

/** Owner-only replacement/clear of one plugin's sealed field map; null clears the whole map.
 * Reuses the scoped lock, version CAS and metadata-only audit. Failures are redacted.
 * @complexity O(b) time/space, payload <=64 KiB; fixed repository I/O.
 */
export async function setCredentialPluginSecret(required: TokenDependencies & { context: CallContext; request: PluginSecretSet }, optional?: CallOptions): Promise<Outcome<PluginSecretStatus>> {
  return boundary({ run: async () => {
    const parsed = z.strictObject({ context: callContextSchema, request: pluginSecretSetSchema }).safeParse({ context: required.context, request: required.request });
    if (!parsed.success) return failure({ code: "invalid_input" });
    const { context, request } = parsed.data;
    if (context.principal.kind !== "owner" || context.principal.ownerId !== context.scope.ownerId) return failure({ code: "forbidden" });
    const plaintext = pluginSecretPrefix + JSON.stringify(request.values);
    if (Buffer.byteLength(plaintext) > 65536) return failure({ code: "invalid_input" });
    const input = { context, pluginId: request.pluginId, connectionId: "plugin-secret." + request.pluginId, plaintext, purpose: "plugin-secret" as const };
    const reference = { scope: context.scope, connectionId: input.connectionId, version: 1 };
    const saved = await withCredentialLock({ locks: required.locks, reference, run: () => saveToken({ input, reference, dependencies: required }, optional) }, optional);
    return saved.ok ? { ok: true, value: { configured: request.values !== null } } : saved;
  } }, optional);
}

/** Host-only read for the bound plugin; returns only requested own fields, with no caching.
 * Missing/cleared is null; foreign, revoked and malformed records fail closed.
 * @complexity Fixed audited I/O and O(b + f) time/space, b<=64 KiB and f<=32 names.
 */
export async function readCredentialPluginSecrets(required: ReaderDependencies & { secretFields: readonly string[] }, optional?: CallOptions): Promise<Outcome<Readonly<Record<string, string>> | null>> {
  if (required.context.principal.kind !== "service") return failure({ code: "forbidden" });
  if (!z.array(z.string()).max(32).safeParse(required.secretFields).success) return failure({ code: "invalid_input" });
  const read = await readTagged({ ...required, connectionId: "plugin-secret." + required.pluginId, prefix: pluginSecretPrefix, schema: pluginSecretSetSchema.shape.values }, optional);
  if (!read.ok || read.value === null) return read;
  const values = read.value;
  return { ok: true, value: Object.fromEntries(required.secretFields.filter(field => Object.hasOwn(values, field)).map(field => [field, values[field]])) };
}

/** Secret-free status via the same audited reader. @complexity Same bounded I/O as the reader. */
export async function credentialPluginSecretStatus(required: ReaderDependencies, optional?: CallOptions): Promise<Outcome<PluginSecretStatus>> {
  const read = await readCredentialPluginSecrets({ ...required, secretFields: [] }, optional);
  return read.ok ? { ok: true, value: { configured: read.value !== null } } : read;
}

/** Validate the distinct client purpose before sealing; ordinary paste cannot claim it. @complexity O(b), b <=64 KiB. */
function purposePayload(required: { input: TokenInput }): Outcome<string> {
  const input = required.input;
  if (!input.purpose) return reservedPurposeId.test(input.connectionId) || input.plaintext.startsWith(clientPrefix) || input.plaintext.startsWith("om.developer-token.") || input.plaintext.startsWith("om.plugin-secret.") ? failure({ code: "forbidden" }) : { ok: true, value: input.plaintext };
  if (input.connectionId !== "oauth-client." + input.pluginId) return failure({ code: "invalid_input" });
  try { return { ok: true, value: clientPrefix + JSON.stringify(declaredClientSchema({ clientFields: input.clientFields ?? [] }).parse(JSON.parse(input.plaintext))) }; }
  catch { return failure({ code: "invalid_input" }); }
}

/** Keep base client fields and optional declared extras; strip all undeclared keys.
 * JSON null clears configuration. @complexity O(f), f<=32 declared extra fields; no effects.
 */
function declaredClientSchema(required: { clientFields: readonly string[] }): z.ZodType<OAuthClientConfiguration> {
  const extras = Object.fromEntries(required.clientFields.map(field => [field, z.string().min(1).max(2048).optional()]));
  return z.object({ ...extras, ...clientSchema.unwrap().shape }).nullable();
}

/** Host-only purpose decoder; returns base fields plus the caller's declared extras.
 * Null clears configuration without reviving revoked token IDs.
 * @complexity Fixed broker/repository I/O and O(b) crypto/JSON, b <=64 KiB; no provider call. */
export async function readCredentialOAuthClient(required: ReaderDependencies & { clientFields?: readonly string[] }, optional?: CallOptions): Promise<Outcome<OAuthClientConfiguration>> {
  const fields = clientFieldsSchema.safeParse(required.clientFields ?? []);
  if (!fields.success) return failure({ code: "invalid_input" });
  return readTagged({ ...required, connectionId: "oauth-client." + required.pluginId, prefix: clientPrefix, schema: declaredClientSchema({ clientFields: fields.data }) }, optional);
}

/** Read only the bound plugin/purpose; decrypt the broker's current version after refresh.
 * Missing/cleared records return null; revoked or reconnect-required records return a denial.
 * @complexity Fixed audited broker/repository I/O; O(b) time/space for crypto/JSON, b<=64 KiB. */
async function readTagged<T>(required: ReaderDependencies & { connectionId: string; prefix: string; schema: z.ZodType<T> }, optional?: CallOptions): Promise<Outcome<T | null>> {
  return boundary({ run: async () => {
    const summary = await required.repo.get({ context: required.context, connectionId: required.connectionId }, optional);
    if (!summary.ok) return summary;
    if (summary.value && summary.value.status !== "connected") return failure({ code: "forbidden" });
    const loaded = await required.repo.getSecret({ context: required.context, connectionId: required.connectionId }, optional);
    if (!loaded.ok) return loaded;
    if (!loaded.value) return { ok: true, value: null };
    if (loaded.value.summary.pluginId !== required.pluginId) return failure({ code: "forbidden" });
    const used = await required.broker.use({ context: required.context, reference: loaded.value.reference, operationId: required.context.correlationId }, optional);
    if (!used.ok) return used;
    const opened = await required.sealer.open({ reference: { ...loaded.value.reference, version: used.value.version }, secret: used.value }, optional);
    if (!opened.ok) return opened;
    if (!opened.value.startsWith(required.prefix)) return failure({ code: "protocol_mismatch" });
    const parsed = required.schema.safeParse(JSON.parse(opened.value.slice(required.prefix.length)));
    return parsed.success ? { ok: true, value: parsed.data } : failure({ code: "protocol_mismatch" });
  } }, optional);
}

/** Reject unexpected repository fields or identity drift before returning an owner DTO. @complexity O(summary bytes). */
function tokenSummary(required: { summary: ConnectionSummary; input: StoredTokenInput }): Outcome<ConnectionSummary> {
  const parsed = summarySchema.safeParse(required.summary);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const summary = parsed.data;
  if (!sameScope({ left: summary.scope, right: required.input.context.scope })) return failure({ code: "protocol_mismatch" });
  if (summary.connectionId !== required.input.connectionId || summary.pluginId !== required.input.pluginId || summary.status !== "connected") return failure({ code: "protocol_mismatch" });
  return { ok: true, value: summary };
}
