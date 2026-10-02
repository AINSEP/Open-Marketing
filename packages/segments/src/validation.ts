import { SegmentCompileError, type AttributeType, type CompileSegmentInput, type SegmentSchema } from "./types.js";

const OPERATORS = ["eq", "ne", "gt", "gte", "lt", "lte"];
const TYPES = ["string", "number", "boolean", "timestamp"];

/** Validate an ordinary record with no unknown keys. @complexity O(keys) time/space. @overallScore 100 */
function record(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SegmentCompileError("INVALID_INPUT", "Expected a record");
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new SegmentCompileError("INVALID_INPUT", "Unknown field");
}

/** Bound user labels and text values without coercion. @complexity O(1) time/space. @overallScore 100 */
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new SegmentCompileError("INVALID_INPUT", "Expected a nonempty string");
  if (value.length > 4096) throw new SegmentCompileError("LIMIT_EXCEEDED", "String exceeds 4096 characters");
}

/** Quote only simple application-owned SQL identifiers, never expressions or qualified paths. @complexity O(n) time/space. @overallScore 100 */
export function quoteIdentifier(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) throw new SegmentCompileError("INVALID_SCHEMA", "Invalid SQL identifier");
  return `"${value}"`;
}

/** Resolve own schema fields; subject input cannot choose a raw database column. @complexity O(1) time/space. @overallScore 100 */
export function attributeMapping(name: string, schema: SegmentSchema): { readonly column: string; readonly type: AttributeType } {
  const descriptor = Object.getOwnPropertyDescriptor(schema.attributes, name);
  if (!descriptor || !("value" in descriptor)) throw new SegmentCompileError("UNKNOWN_ATTRIBUTE", "Attribute is not in the schema");
  return descriptor.value;
}

/** Validate exact millisecond ISO UTC timestamps, rejecting rollover dates. @complexity O(n) time, O(1) space. @overallScore 100 */
function timestamp(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new SegmentCompileError("TYPE_MISMATCH", "Expected an ISO UTC timestamp with milliseconds");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new SegmentCompileError("TYPE_MISMATCH", "Invalid timestamp");
}

/** Validate mapped scalar type before binding; null has separate explicit operators. @complexity O(value length) time, O(1) space. @overallScore 100 */
function scalarType(value: unknown, type: AttributeType): void {
  if (type === "timestamp") { timestamp(value); return; }
  if (typeof value !== type) throw new SegmentCompileError("TYPE_MISMATCH", "Attribute value type mismatch");
  if (type === "number" && !Number.isFinite(value)) throw new SegmentCompileError("TYPE_MISMATCH", "Number must be finite");
  if (typeof value === "string" && value.length > 4096) throw new SegmentCompileError("LIMIT_EXCEEDED", "String exceeds 4096 characters");
}

/** Validate fixed comparison vocabulary and restrict ordering to numeric/time columns. @complexity O(1) time/space. @overallScore 100 */
function comparison(operator: unknown, type: AttributeType): void {
  if (typeof operator !== "string" || !OPERATORS.includes(operator)) throw new SegmentCompileError("UNSUPPORTED_OPERATOR", "Unsupported comparison operator");
  if (operator === "eq" || operator === "ne") return;
  if (type !== "number" && type !== "timestamp") throw new SegmentCompileError("TYPE_MISMATCH", "Ordering requires a numeric or timestamp attribute");
}

/** Validate a leaf with explicit SQL-null semantics. @complexity O(list length) time, O(1) space. @overallScore 96 — Low: operator variants share validation routing. */
function attribute(node: Record<string, unknown>, schema: SegmentSchema): void {
  record(node, ["kind", "attribute", "operator", "value"]);
  text(node.attribute);
  const mapping = attributeMapping(node.attribute, schema);
  if (node.operator === "exists") {
    if ("value" in node) throw new SegmentCompileError("INVALID_INPUT", "Exists does not accept a value");
    return;
  }
  validateAttributeValue(node, mapping.type);
}

/** Bound in-lists and require explicit equality semantics for null. @complexity O(list length) time, O(1) space. @overallScore 96 — Low: three value forms require distinct branches. */
function validateAttributeValue(node: Record<string, unknown>, type: AttributeType): void {
  if (node.operator === "in") {
    if (!Array.isArray(node.value) || node.value.length < 1 || node.value.length > 100) throw new SegmentCompileError("LIMIT_EXCEEDED", "In-list must contain 1–100 values");
    for (const value of node.value) scalarType(value, type);
    return;
  }
  comparison(node.operator, type);
  if (node.value === null) {
    if (node.operator !== "eq" && node.operator !== "ne") throw new SegmentCompileError("TYPE_MISMATCH", "Null only supports eq/ne");
    return;
  }
  scalarType(node.value, type);
}

/** Validate an explicit half-open event window and nonnegative occurrence comparison. @complexity O(input length) time, O(1) space. @overallScore 100 */
function event(node: Record<string, unknown>, schema: SegmentSchema): void {
  record(node, ["kind", "eventName", "window", "count"]);
  if (!schema.events) throw new SegmentCompileError("INVALID_SCHEMA", "Events mapping is required");
  text(node.eventName);
  record(node.window, ["from", "to"]);
  timestamp(node.window.from);
  timestamp(node.window.to);
  if (node.window.from >= node.window.to) throw new SegmentCompileError("INVALID_INPUT", "Event window must have from before to");
  if (node.count !== undefined) validateCount(node.count);
}

/** Validate count comparisons without fractional, negative or unsafe integer counts. @complexity O(1) time/space. @overallScore 100 */
function validateCount(count: unknown): void {
  record(count, ["operator", "value"]);
  comparison(count.operator, "number");
  if (typeof count.value !== "number" || !Number.isSafeInteger(count.value) || count.value < 0) throw new SegmentCompileError("TYPE_MISMATCH", "Count must be a nonnegative safe integer");
}

/** Validate a bounded tree before SQL generation; cycles terminate at the depth limit. @complexity O(nodes + values) time, O(depth) stack. @overallScore 96 — Low: closed AST traversal is intentionally centralized. */
function condition(node: unknown, schema: SegmentSchema, state: { nodes: number }, depth: number): void {
  state.nodes += 1;
  if (depth > 16 || state.nodes > 1000) throw new SegmentCompileError("LIMIT_EXCEEDED", "Condition tree exceeds depth/node limit");
  record(node, ["kind", "conditions", "condition", "attribute", "operator", "value", "eventName", "window", "count"]);
  switch (node.kind) {
    case "and": case "or":
      record(node, ["kind", "conditions"]);
      if (!Array.isArray(node.conditions) || node.conditions.length < 1 || node.conditions.length > 100) throw new SegmentCompileError("LIMIT_EXCEEDED", "Logical groups require 1–100 conditions");
      for (const child of node.conditions) condition(child, schema, state, depth + 1);
      return;
    case "not":
      record(node, ["kind", "condition"]);
      condition(node.condition, schema, state, depth + 1);
      return;
    case "attribute": attribute(node, schema); return;
    case "event": event(node, schema); return;
    default: throw new SegmentCompileError("INVALID_INPUT", "Unsupported condition kind");
  }
}

/** Validate application mappings before any SQL construction. @complexity O(mapped attributes) time/space, capped at 1000. @overallScore 100 */
function validateSchema(schema: SegmentSchema): void {
  record(schema, ["subjects", "attributes", "events"]);
  record(schema.subjects, ["table", "idColumn", "tenantColumn", "workspaceColumn"]);
  for (const key of ["table", "idColumn", "tenantColumn", "workspaceColumn"] as const) quoteIdentifier(schema.subjects[key]);
  if (!schema.attributes || typeof schema.attributes !== "object" || Array.isArray(schema.attributes)) throw new SegmentCompileError("INVALID_SCHEMA", "Attribute mapping is required");
  const keys = Object.keys(schema.attributes);
  if (keys.length > 1000) throw new SegmentCompileError("LIMIT_EXCEEDED", "Too many mapped attributes");
  for (const key of keys) validateMapping(key, schema);
  if (schema.events) validateEventsMapping(schema.events);
}

/** Validate one mapped attribute and reject accessor mappings. @complexity O(identifier length) time, O(1) space. @overallScore 100 */
function validateMapping(key: string, schema: SegmentSchema): void {
  text(key);
  const mapping = attributeMapping(key, schema);
  record(mapping, ["column", "type"]);
  quoteIdentifier(mapping.column);
  if (!TYPES.includes(mapping.type)) throw new SegmentCompileError("INVALID_SCHEMA", "Unsupported attribute type");
}

/** Validate all required event identifiers. @complexity O(identifier length) time, O(1) space. @overallScore 100 */
function validateEventsMapping(events: NonNullable<SegmentSchema["events"]>): void {
  record(events, ["table", "subjectColumn", "tenantColumn", "workspaceColumn", "nameColumn", "occurredAtColumn"]);
  for (const key of ["table", "subjectColumn", "tenantColumn", "workspaceColumn", "nameColumn", "occurredAtColumn"] as const) quoteIdentifier(events[key]);
}

/** Validate the whole boundary; no SQL is returned for partially valid input. @complexity O(nodes + mappings + scalar bytes) time, O(depth + mappings) space. @overallScore 100 */
export function validateInput(input: CompileSegmentInput): void {
  record(input, ["definition", "tenantId", "workspaceId", "schema"]);
  text(input.tenantId);
  if (!input.tenantId.trim()) throw new SegmentCompileError("INVALID_INPUT", "Tenant is required");
  text(input.workspaceId);
  if (!input.workspaceId.trim()) throw new SegmentCompileError("INVALID_INPUT", "Workspace is required");
  record(input.definition, ["id", "version", "languageVersion", "condition"]);
  text(input.definition.id);
  if (input.definition.languageVersion !== 1 || !Number.isSafeInteger(input.definition.version) || input.definition.version < 1) throw new SegmentCompileError("INVALID_INPUT", "Unsupported definition version");
  validateSchema(input.schema);
  condition(input.definition.condition, input.schema, { nodes: 0 }, 1);
}
