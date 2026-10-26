/** Paste-token ingress. Credential contents remain opaque to the feature. */
import { z } from "zod";
import { callContextSchema, connectIntegrationTokenSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { CredentialBrokerPort, CredentialAuditPort, CredentialLockPort, CredentialRepoPort, SecretSealerPort } from "./ports.js";
import type { ConnectionSummary, CredentialReference } from "./types.js";
import { withCredentialLock } from "./locks.js";
import { boundary, failure, sameScope, summarySchema } from "./rules.js";

const tokenSchema = connectIntegrationTokenSchema.extend({ context: callContextSchema, purpose: z.enum(["oauth-client", "developer-token"]).optional() });
const clientPrefix = "om.oauth.client.v1:";
const developerPrefix = "om.developer-token.v1:";
const developerSchema = z.string().regex(/^[A-Za-z0-9]{22}$/).nullable();
const clientSchema = z.strictObject({ clientId: z.string().min(1).max(2048), clientSecret: z.string().min(1).max(8192).optional() }).nullable();
const metaClientSchema = clientSchema.unwrap().extend({ configId: z.string().regex(/^[1-9][0-9]{0,127}$/) }).nullable();
type OAuthClientConfiguration = z.infer<typeof metaClientSchema> | z.infer<typeof clientSchema>;
type TokenInput = z.infer<typeof tokenSchema>;
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
    const parsed = tokenSchema.safeParse({ context: required.context, connectionId: required.connectionId, pluginId: required.pluginId, plaintext: required.plaintext, purpose: required.purpose });
    if (!parsed.success || Buffer.byteLength(parsed.data.plaintext) > 65536) return failure({ code: "invalid_input" });
    const plaintext = purposePayload({ input: parsed.data });
    if (!plaintext.ok) return plaintext;
    const input = { ...parsed.data, plaintext: plaintext.value };
    if (input.context.principal.kind !== "owner" || input.context.principal.ownerId !== input.context.scope.ownerId) return failure({ code: "forbidden" });
    const reference = { scope: input.context.scope, connectionId: input.connectionId, version: 1 };
    return withCredentialLock({ locks: required.locks, reference, run: () => saveToken({ input, reference, dependencies: required }, optional) }, optional);
  } }, optional);
}

/** A duplicate cannot replace another plugin or restore revoked authority. @complexity O(b), fixed I/O. */
async function saveToken(required: { input: TokenInput; reference: CredentialReference; dependencies: TokenDependencies }, optional?: CallOptions): Promise<Outcome<ConnectionSummary>> {
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

/** Validate the distinct client purpose before sealing; ordinary paste cannot claim it. @complexity O(b), b <=64 KiB. */
function purposePayload(required: { input: TokenInput }): Outcome<string> {
  const input = required.input;
  if (!input.purpose) return /^(oauth-client|developer-token)\./.test(input.connectionId) || input.plaintext.startsWith(clientPrefix) || input.plaintext.startsWith("om.developer-token.") ? failure({ code: "forbidden" }) : { ok: true, value: input.plaintext };
  if (input.purpose === "developer-token") return developerPayload({ input });
  if (input.connectionId !== "oauth-client." + input.pluginId) return failure({ code: "invalid_input" });
  try { return { ok: true, value: clientPrefix + JSON.stringify(oauthClientSchema({ pluginId: input.pluginId }).parse(JSON.parse(input.plaintext))) }; }
  catch { return failure({ code: "invalid_input" }); }
}

/** Meta requires its user-token Business Login config ID; other plugins reject that field.
 * JSON null still clears either configuration. @complexity O(1) schema selection, no effects.
 */
function oauthClientSchema(required: { pluginId: string }): typeof clientSchema | typeof metaClientSchema {
  return required.pluginId === "meta-ads" ? metaClientSchema : clientSchema;
}

/** Google-only compatibility configuration; JSON null clears it. @complexity O(b), b<=64 KiB. */
function developerPayload(required: { input: TokenInput }): Outcome<string> {
  if (required.input.pluginId !== "google-ads" || required.input.connectionId !== "developer-token.google-ads") return failure({ code: "invalid_input" });
  try { return { ok: true, value: developerPrefix + JSON.stringify(developerSchema.parse(JSON.parse(required.input.plaintext))) }; }
  catch { return failure({ code: "invalid_input" }); }
}

/** Host-only Google configuration decoder; never returns OAuth material. Missing is compatible.
 * @complexity Fixed audited broker/repository I/O; O(b) crypto/JSON, b<=64 KiB; no vendor call. */
export async function readCredentialDeveloperToken(required: ReaderDependencies, optional?: CallOptions): Promise<Outcome<string | null>> {
  if (required.pluginId !== "google-ads" || required.context.principal.kind !== "service") return failure({ code: "forbidden" });
  return readTagged({ ...required, connectionId: "developer-token.google-ads", prefix: developerPrefix, schema: developerSchema }, optional);
}

/** Host-only purpose decoder; Meta additionally requires configId, other plugins reject it.
 * Null clears configuration without reviving revoked token IDs.
 * @complexity Fixed broker/repository I/O and O(b) crypto/JSON, b <=64 KiB; no provider call. */
export async function readCredentialOAuthClient(required: ReaderDependencies, optional?: CallOptions): Promise<Outcome<OAuthClientConfiguration>> {
  return readTagged({ ...required, connectionId: "oauth-client." + required.pluginId, prefix: clientPrefix, schema: oauthClientSchema({ pluginId: required.pluginId }) }, optional);
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
function tokenSummary(required: { summary: ConnectionSummary; input: TokenInput }): Outcome<ConnectionSummary> {
  const parsed = summarySchema.safeParse(required.summary);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const summary = parsed.data;
  if (!sameScope({ left: summary.scope, right: required.input.context.scope })) return failure({ code: "protocol_mismatch" });
  if (summary.connectionId !== required.input.connectionId || summary.pluginId !== required.input.pluginId || summary.status !== "connected") return failure({ code: "protocol_mismatch" });
  return { ok: true, value: summary };
}
