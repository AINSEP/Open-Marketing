import { z } from "zod";
import { appErrorSchema, callContextSchema, idSchema, scopeSchema } from "@open-marketing/contracts";
import type { AppError, CallOptions, Outcome, Scope } from "@open-marketing/contracts";
import type { CredentialReference } from "./types.js";

export const referenceSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, version: z.number().int().min(1).max(2147483647) });
export const secretSchema = z.strictObject({ ciphertext: z.string().min(1).max(131072), version: z.number().int().min(1).max(2147483647), aadDigest: z.string().regex(/^[a-f0-9]{64}$/) });
export const connectSchema = z.strictObject({ context: callContextSchema, request: z.strictObject({ pluginId: idSchema, returnUri: z.string().url().max(2048) }) });
const callbackFields = { state: z.string().min(32).max(256), redirectUri: z.string().url().max(2048) };
const codeResult = { code: z.string().min(1).max(2048) };
const errorResult = { error: z.string().regex(/^[a-z_]{1,64}$/), error_description: z.string().max(2048).optional() };
export const browserCallbackSchema = z.union([z.strictObject({ ...callbackFields, ...codeResult }), z.strictObject({ ...callbackFields, ...errorResult }).transform(({ state, redirectUri, error }) => ({ state, redirectUri, error }))]);
export const callbackSchema = z.union([z.strictObject({ transactionId: idSchema, ...callbackFields, ...codeResult }), z.strictObject({ transactionId: idSchema, ...callbackFields, ...errorResult }).transform(({ transactionId, state, redirectUri, error }) => ({ transactionId, state, redirectUri, error }))]);
export const statusSchema = z.strictObject({ context: callContextSchema, transactionId: idSchema });
export const lookupSchema = z.strictObject({ context: callContextSchema, connectionId: idSchema });
export const storeSchema = z.strictObject({ context: callContextSchema, reference: referenceSchema, secret: secretSchema, pluginId: idSchema });
export const summarySchema = z.strictObject({ connectionId: idSchema, scope: scopeSchema, pluginId: idSchema, status: z.enum(["connected", "revoked", "reconnect_required"]) });
export const recordSchema = z.strictObject({ summary: summarySchema, reference: referenceSchema, secret: secretSchema }).refine(record =>
  record.secret.version === record.reference.version && record.summary.connectionId === record.reference.connectionId
  && record.summary.scope.ownerId === record.reference.scope.ownerId && record.summary.scope.workspaceId === record.reference.scope.workspaceId);
export const brokerSchema = z.strictObject({ context: callContextSchema, reference: referenceSchema, operationId: idSchema });
export const challengeSchema = z.strictObject({ transactionId: idSchema, authorizationUrl: z.string().url().max(8192), expiresAt: z.number().int().nonnegative() });
export const configurationSchema = z.strictObject({ hkdfSalt: z.string().min(16).max(1024), envVarName: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/), keyFilePath: z.string().min(1).max(4096) });

/** Stable redacted failure; no foreign exception/input is echoed. @complexity O(1). */
export function failure(required: { code: AppError["code"]; message?: string }): { readonly ok: false; readonly error: AppError } {
  const messages: Partial<Record<AppError["code"], string>> = {
    unauthenticated: "Connection unavailable; reconnect required",
    conflict: "Credential version changed; resolve current connection",
    expired: "Connection attempt expired or consumed; begin connect again",
  };
  return { ok: false, error: { code: required.code, message: messages[required.code] ?? "Credential operation denied", retryable: required.code === "unavailable" } };
}
/** Sanitize foreign failures, including returned error messages. @complexity O(1) plus injected effect. */
export async function boundary<T>(required: { run: () => Promise<Outcome<T>> }, optional?: CallOptions): Promise<Outcome<T>> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  try {
    const outcome = await required.run();
    if (!outcome.ok) {
      const parsed = appErrorSchema.shape.code.safeParse(outcome.error.code);
      return failure({ code: parsed.success ? parsed.data : "unavailable" });
    }
    return outcome;
  } catch {
    return failure({ code: "unavailable" });
  }
}
/** Collision-free scope key. @complexity O(identifier length). */
export function scopeKey(required: { scope: Scope; connectionId: string }): string {
  return JSON.stringify([required.scope.ownerId, required.scope.workspaceId, required.connectionId]);
}
/** Authenticated bytes change with every authority/version field. @complexity O(identifier length). */
export function authenticatedData(required: { reference: CredentialReference }): string {
  return JSON.stringify(["om.credentials.aes-gcm.v1", required.reference.scope.ownerId, required.reference.scope.workspaceId, required.reference.connectionId, required.reference.version]);
}
/** Explicit scope equality. @complexity O(identifier length). */
export function sameScope(required: { left: Scope; right: Scope }): boolean {
  return required.left.ownerId === required.right.ownerId && required.left.workspaceId === required.right.workspaceId;
}

export const revocationSchema = z.strictObject({ connectionId: idSchema, revokedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
