import type { AppError, Outcome } from "@open-marketing/contracts";

/** Local JSON Schema subset used for closed tool inputs and provider projections.
 * No schema fetches or executable validators. Extend only with a paired fixture. */
export interface Schema {
  type: "object" | "array" | "string" | "integer" | "number" | "boolean";
  properties?: Record<string, Schema>; required?: string[]; additionalProperties?: false;
  items?: Schema; minItems?: number; maxItems?: number; minLength?: number; maxLength?: number;
  minimum?: number; maximum?: number; exclusiveMinimum?: number; pattern?: string; enum?: readonly (string | number | boolean)[];
}
/** Stable boundary error without tainted payloads. */
export function failure<T>(required: { code: AppError["code"]; message: string }): Outcome<T> {
  return { ok: false, error: { ...required, retryable: false } };
}
export function success<T>(required: { value: T }): Outcome<T> { return { ok: true, value: required.value }; }
/** Foreign adapters may throw opaque failures. Preserve a stable boundary error; existing
 * write claims remain unknown so this result never authorizes a blind retry. */
export async function protect<T>(required: { work: () => Promise<Outcome<T>> }): Promise<Outcome<T>> {
  try { return await required.work(); }
  catch { return failure({ code: "unavailable", message: "Plugin boundary unavailable; reconcile any claimed operation" }); }
}
/** Parse one bounded value against locally shipped schema. @complexity O(n), depth <=16.
 * @example parse({ schema: toolSchemas.pause, input: payload }) */
export function parse<T>(required: { schema: Schema; input: unknown }): Outcome<T> {
  if (!matches({ ...required, depth: 0 })) return failure({ code: "invalid_input", message: "Boundary schema validation failed" });
  return success({ value: required.input as T });
}
function matches(required: { schema: Schema; input: unknown; depth: number }): boolean {
  const { schema, input, depth } = required;
  if (depth > 16) return false;
  if (schema.enum && !schema.enum.includes(input as string)) return false;
  switch (schema.type) {
    case "object": return objectMatches(required);
    case "array": return arrayMatches(required);
    case "string": return stringMatches({ schema, input });
    case "integer": return integerMatches({ schema, input });
    case "number": return numberMatches({ schema, input });
    case "boolean": return typeof input === "boolean";
    default: return false;
  }
}
function objectMatches(required: { schema: Schema; input: unknown; depth: number }): boolean {
  const { schema, input, depth } = required;
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const value = input as Record<string, unknown>;
  const properties = schema.properties ?? {};
  if ((schema.required ?? []).some(key => !Object.hasOwn(value, key))) return false;
  if (Object.keys(value).some(key => !Object.hasOwn(properties, key))) return false;
  return Object.entries(value).every(([key, entry]) => matches({ schema: properties[key], input: entry, depth: depth + 1 }));
}
function arrayMatches(required: { schema: Schema; input: unknown; depth: number }): boolean {
  const { schema, input, depth } = required;
  if (!Array.isArray(input) || !schema.items) return false;
  if (input.length < (schema.minItems ?? 0) || input.length > (schema.maxItems ?? 100)) return false;
  const itemSchema = schema.items;
  return input.every(entry => matches({ schema: itemSchema, input: entry, depth: depth + 1 }));
}
function stringMatches(required: { schema: Schema; input: unknown }): boolean {
  const { schema, input } = required;
  if (typeof input !== "string") return false;
  if (input.length < (schema.minLength ?? 0) || input.length > (schema.maxLength ?? 4096)) return false;
  return !schema.pattern || new RegExp(schema.pattern).test(input);
}
function integerMatches(required: { schema: Schema; input: unknown }): boolean {
  const { schema, input } = required;
  if (typeof input !== "number" || !Number.isSafeInteger(input)) return false;
  return input >= (schema.minimum ?? 0) && input <= (schema.maximum ?? Number.MAX_SAFE_INTEGER);
}
/** Validate finite decimal boundaries from Zod's JSON projection; pure O(1). */
function numberMatches(required: { schema: Schema; input: unknown }): boolean {
  const { schema, input } = required;
  if (typeof input !== "number" || !Number.isFinite(input)) return false;
  if (schema.exclusiveMinimum !== undefined && input <= schema.exclusiveMinimum) return false;
  return input >= (schema.minimum ?? -Infinity) && input <= (schema.maximum ?? Infinity);
}
/** Schema constructors keep the entire public MCP input schema inspectable. */
export function object(required: { properties: Record<string, Schema>; optional?: string[] }): Schema {
  return { type: "object", properties: required.properties, required: Object.keys(required.properties).filter(key => !required.optional?.includes(key)), additionalProperties: false };
}
export const id: Schema = { type: "string", minLength: 1, maxLength: 256 };
export const numericId: Schema = { type: "string", minLength: 1, maxLength: 19, pattern: "^[1-9][0-9]*$" };
export const micros: Schema = { type: "string", minLength: 1, maxLength: 18, pattern: "^[1-9][0-9]*$" };
export const epoch: Schema = { type: "integer", minimum: 0, maximum: 4102444800000 };
export const date: Schema = { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", maxLength: 10 };
export const text: Schema = { type: "string", minLength: 1, maxLength: 256 };
export const bool: Schema = { type: "boolean" };
export const currency: Schema = { type: "string", pattern: "^[A-Z]{3}$", maxLength: 3 };
export const status: Schema = { type: "string", enum: ["PAUSED", "ENABLED", "REMOVED"] };
export function array(required: { items: Schema; min: number; max: number }): Schema {
  return { type: "array", items: required.items, minItems: required.min, maxItems: required.max };
}
