import { z } from "zod";
/** Pure shared values; schemas reject unknown authority-bearing fields. */
export const idSchema = z.string().min(1).max(256);
export const epochSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const moneySchema = z.strictObject({ minorUnits: epochSchema, currency: z.string().regex(/^[A-Z]{3}$/) });
export const timeWindowSchema = z.strictObject({ start: epochSchema, end: epochSchema }).refine(value => value.start < value.end);
export const scopeSchema = z.strictObject({ ownerId: idSchema, workspaceId: idSchema });
export const principalSchema = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("owner"), ownerId: idSchema }), z.strictObject({ kind: z.literal("agent"), agentInstanceId: idSchema, runId: idSchema }), z.strictObject({ kind: z.literal("service"), serviceId: idSchema })]);
export const appErrorSchema = z.strictObject({ code: z.enum(["not_implemented", "invalid_input", "unauthenticated", "forbidden", "unavailable", "conflict", "cancelled", "expired", "protocol_mismatch", "limit_exceeded"]), message: z.string().max(1024), retryable: z.boolean() });
export type AppError = z.infer<typeof appErrorSchema>;
export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AppError };
export type Scope = z.infer<typeof scopeSchema>;
export type Principal = z.infer<typeof principalSchema>;
export type PrincipalReference = Principal;
export type Money = z.infer<typeof moneySchema>;
export type TimeWindow = z.infer<typeof timeWindowSchema>;
export type OperationId = string;
export type EventCursor = number;
export const callContextSchema = z.strictObject({ scope: scopeSchema, principal: principalSchema, correlationId: idSchema, traceId: idSchema, runId: idSchema.optional() });
export type CallContext = z.infer<typeof callContextSchema>;
export interface ServiceContext { readonly scope: Scope; readonly serviceId: string; readonly correlationId: string; readonly traceId: string }
export interface CallOptions { readonly signal?: AbortSignal }
export interface ClockPort { now(required: Record<string, never>): number }
export interface IdPort { next(required: Record<string, never>): string }
export interface ObserverEvent { readonly operation: string; readonly outcome: string; readonly correlationId: string; readonly traceId: string; readonly runId?: string }
export interface ObserverPort { observe(required: ObserverEvent): void }
export const pageQuerySchema = z.strictObject({ limit: z.number().int().min(1).max(100), cursor: idSchema.optional() });
export type PageQuery = z.infer<typeof pageQuerySchema>;
export interface Page<T> { readonly items: readonly T[]; readonly cursor: string | null }
/** Explicit unavailable result. Never grants authority or performs effects. @example notImplemented({ operation: "jobs.enqueue" }) */
export function notImplemented<T>(required: { operation: string }): Outcome<T> { return { ok: false, error: { code: "not_implemented", message: required.operation + " is not implemented", retryable: false } }; }
/** Schema parsing maps tainted boundary data to stable errors without leaking it. @complexity Schema-dependent bounded traversal. */
export function parseBoundary<T>(required: { schema: z.ZodType<T>; input: unknown }): Outcome<T> {
 const parsed = required.schema.safeParse(required.input);
 if (!parsed.success) return { ok: false, error: { code: "invalid_input", message: "Boundary validation failed", retryable: false } };
 return { ok: true, value: parsed.data };
}
