/** Paste-token ingress. Credential contents remain opaque to the feature. */
import { z } from "zod";
import { callContextSchema, connectIntegrationTokenSchema } from "@open-marketing/contracts";
import type { CallOptions, Outcome } from "@open-marketing/contracts";
import type { CredentialAuditPort, CredentialLockPort, CredentialRepoPort, SecretSealerPort } from "./ports.js";
import type { ConnectionSummary, CredentialReference } from "./types.js";
import { withCredentialLock } from "./locks.js";
import { boundary, failure, sameScope, summarySchema } from "./rules.js";

const tokenSchema = connectIntegrationTokenSchema.extend({ context: callContextSchema });
type TokenInput = z.infer<typeof tokenSchema>;
type TokenDependencies = { repo: CredentialRepoPort; sealer: SecretSealerPort; locks: CredentialLockPort; audit: CredentialAuditPort };

/** Seal a new owner connection under the existing scoped lock; audit metadata before storage.
 * Existing IDs conflict, including revoked IDs. Reconnect supplies a fresh ID.
 * Returns a validated secret-free summary or a redacted failure; never echoes plaintext.
 * @example await connectCredentialToken({ context, connectionId, pluginId, plaintext, repo, sealer, locks, audit });
 * @complexity O(b) time/space for <=64 KiB UTF-8; a fixed number of repository operations.
 */
export async function connectCredentialToken(required: TokenInput & TokenDependencies, optional?: CallOptions): Promise<Outcome<ConnectionSummary>> {
  return boundary({ run: async () => {
    const parsed = tokenSchema.safeParse({ context: required.context, connectionId: required.connectionId, pluginId: required.pluginId, plaintext: required.plaintext });
    if (!parsed.success || Buffer.byteLength(parsed.data.plaintext) > 65536) return failure({ code: "invalid_input" });
    const input = parsed.data;
    if (input.context.principal.kind !== "owner" || input.context.principal.ownerId !== input.context.scope.ownerId) return failure({ code: "forbidden" });
    const reference = { scope: input.context.scope, connectionId: input.connectionId, version: 1 };
    return withCredentialLock({ locks: required.locks, reference, run: () => saveToken({ input, reference, dependencies: required }, optional) }, optional);
  } }, optional);
}

/** A duplicate cannot replace another plugin or restore revoked authority. @complexity O(b), fixed I/O. */
async function saveToken(required: { input: TokenInput; reference: CredentialReference; dependencies: TokenDependencies }, optional?: CallOptions): Promise<Outcome<ConnectionSummary>> {
  const { input, reference, dependencies } = required;
  const existing = await dependencies.repo.get({ context: input.context, connectionId: input.connectionId }, optional);
  if (!existing.ok) return existing;
  if (existing.value) return failure({ code: "conflict" });
  const sealed = await dependencies.sealer.seal({ reference, plaintext: input.plaintext }, optional);
  if (!sealed.ok) return sealed;
  const audited = await dependencies.audit.record({ context: input.context, connectionId: input.connectionId, operation: "credentials.connect" }, optional);
  if (!audited.ok) return audited;
  const stored = await dependencies.repo.store({ context: input.context, reference, secret: sealed.value, pluginId: input.pluginId }, optional);
  if (!stored.ok) return stored;
  return tokenSummary({ summary: stored.value, input });
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
