import { SegmentCompileError, type AttributeType, type CompileSegmentInput, type SegmentSchema } from "./types.js";
const OPERATORS = ["eq", "ne", "gt", "gte", "lt", "lte"];
const TYPES = ["string", "number", "boolean", "timestamp"];
/** Validate an ordinary record with no unknown keys. @complexity O(keys) time/space.  */
function record({ value, allowed }: {
    value: unknown;
    allowed: readonly string[];
}): asserts value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new SegmentCompileError({ code: "INVALID_INPUT", message: "Expected a record" });
    if (Object.keys(value).some((key) => !allowed.includes(key)))
        throw new SegmentCompileError({ code: "INVALID_INPUT", message: "Unknown field" });
}
/** Bound user labels and text values without coercion. @complexity O(1) time/space.  */
function text({ value }: {
    value: unknown;
}): asserts value is string {
    if (typeof value !== "string" || value.length === 0)
        throw new SegmentCompileError({ code: "INVALID_INPUT", message: "Expected a nonempty string" });
    if (value.length > 4096)
        throw new SegmentCompileError({ code: "LIMIT_EXCEEDED", message: "String exceeds 4096 characters" });
}
/** Quote only simple application-owned SQL identifiers, never expressions or qualified paths. @complexity O(n) time/space.  */
export function quoteIdentifier({ value }: {
    value: string;
}): string {
    if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value))
        throw new SegmentCompileError({ code: "INVALID_SCHEMA", message: "Invalid SQL identifier" });
    return `"${value}"`;
}
/** Resolve own schema fields; subject input cannot choose a raw database column. @complexity O(1) time/space.  */
export function attributeMapping({ name, schema }: {
    name: string;
    schema: SegmentSchema;
}): {
    readonly column: string;
    readonly type: AttributeType;
} {
    const descriptor = Object.getOwnPropertyDescriptor(schema.attributes, name);
    if (!descriptor || !("value" in descriptor))
        throw new SegmentCompileError({ code: "UNKNOWN_ATTRIBUTE", message: "Attribute is not in the schema" });
    return descriptor.value;
}
/** Validate exact millisecond ISO UTC timestamps, rejecting rollover dates. @complexity O(n) time, O(1) space.  */
function timestamp({ value }: {
    value: unknown;
}): asserts value is string {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
        throw new SegmentCompileError({ code: "TYPE_MISMATCH", message: "Expected an ISO UTC timestamp with milliseconds" });
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value)
        throw new SegmentCompileError({ code: "TYPE_MISMATCH", message: "Invalid timestamp" });
}
/** Validate mapped scalar type before binding; null has separate explicit operators. @complexity O(value length) time, O(1) space.  */
function scalarType({ value, type }: {
    value: unknown;
    type: AttributeType;
}): void {
    if (type === "timestamp") {
        timestamp({ value: value });
        return;
    }
    if (typeof value !== type)
        throw new SegmentCompileError({ code: "TYPE_MISMATCH", message: "Attribute value type mismatch" });
    if (type === "number" && !Number.isFinite(value))
        throw new SegmentCompileError({ code: "TYPE_MISMATCH", message: "Number must be finite" });
    if (typeof value === "string" && value.length > 4096)
        throw new SegmentCompileError({ code: "LIMIT_EXCEEDED", message: "String exceeds 4096 characters" });
}
/** Validate fixed comparison vocabulary and restrict ordering to numeric/time columns. @complexity O(1) time/space.  */
function comparison({ operator, type }: {
    operator: unknown;
    type: AttributeType;
}): void {
    if (typeof operator !== "string" || !OPERATORS.includes(operator))
        throw new SegmentCompileError({ code: "UNSUPPORTED_OPERATOR", message: "Unsupported comparison operator" });
    if (operator === "eq" || operator === "ne")
        return;
    if (type !== "number" && type !== "timestamp")
        throw new SegmentCompileError({ code: "TYPE_MISMATCH", message: "Ordering requires a numeric or timestamp attribute" });
}
/** Validate a leaf with explicit SQL-null semantics. @complexity O(list length) time, O(1) space.  */
function attribute(node: Record<string, unknown>, schema: SegmentSchema): void {
    record({ value: node, allowed: ["kind", "attribute", "operator", "value"] });
    text({ value: node.attribute });
    const mapping = attributeMapping({ name: node.attribute, schema: schema });
    if (node.operator === "exists") {
        if ("value" in node)
            throw new SegmentCompileError({ code: "INVALID_INPUT", message: "Exists does not accept a value" });
        return;
    }
    validateAttributeValue({ node: node, type: mapping.type });
}
/** Bound in-lists and require explicit equality semantics for null. @complexity O(list length) time, O(1) space.  */
function validateAttributeValue({ node, type }: {
    node: Record<string, unknown>;
    type: AttributeType;
}): void {
    if (node.operator === "in") {
        if (!Array.isArray(node.value) || node.value.length < 1 || node.value.length > 100)
            throw new SegmentCompileError({ code: "LIMIT_EXCEEDED", message: "In-list must contain 1–100 values" });
        for (const value of node.value)
            scalarType({ value: value, type: type });
        return;
    }
    comparison({ operator: node.operator, type: type });
    if (node.value === null) {
        if (node.operator !== "eq" && node.operator !== "ne")
            throw new SegmentCompileError({ code: "TYPE_MISMATCH", message: "Null only supports eq/ne" });
        return;
    }
    scalarType({ value: node.value, type: type });
}
/** Validate an explicit half-open event window and nonnegative occurrence comparison. @complexity O(input length) time, O(1) space.  */
function event(node: Record<string, unknown>, schema: SegmentSchema): void {
    record({ value: node, allowed: ["kind", "eventName", "window", "count"] });
    if (!schema.events)
        throw new SegmentCompileError({ code: "INVALID_SCHEMA", message: "Events mapping is required" });
    text({ value: node.eventName });
    record({ value: node.window, allowed: ["from", "to"] });
    timestamp({ value: node.window.from });
    timestamp({ value: node.window.to });
    if (node.window.from >= node.window.to)
        throw new SegmentCompileError({ code: "INVALID_INPUT", message: "Event window must have from before to" });
    if (node.count !== undefined)
        validateCount({ count: node.count });
}
/** Validate count comparisons without fractional, negative or unsafe integer counts. @complexity O(1) time/space.  */
function validateCount({ count }: {
    count: unknown;
}): void {
    record({ value: count, allowed: ["operator", "value"] });
    comparison({ operator: count.operator, type: "number" });
    if (typeof count.value !== "number" || !Number.isSafeInteger(count.value) || count.value < 0)
        throw new SegmentCompileError({ code: "TYPE_MISMATCH", message: "Count must be a nonnegative safe integer" });
}
/** Validate a bounded tree before SQL generation; cycles terminate at the depth limit. @complexity O(nodes + values) time, O(depth) stack.  */
function condition({ node, schema, state, depth }: {
    node: unknown;
    schema: SegmentSchema;
    state: {
        nodes: number;
    };
    depth: number;
}): void {
    state.nodes += 1;
    if (depth > 16 || state.nodes > 1000)
        throw new SegmentCompileError({ code: "LIMIT_EXCEEDED", message: "Condition tree exceeds depth/node limit" });
    record({ value: node, allowed: ["kind", "conditions", "condition", "attribute", "operator", "value", "eventName", "window", "count"] });
    switch (node.kind) {
        case "and":
        case "or":
            record({ value: node, allowed: ["kind", "conditions"] });
            if (!Array.isArray(node.conditions) || node.conditions.length < 1 || node.conditions.length > 100)
                throw new SegmentCompileError({ code: "LIMIT_EXCEEDED", message: "Logical groups require 1–100 conditions" });
            for (const child of node.conditions)
                condition({ node: child, schema: schema, state: state, depth: depth + 1 });
            return;
        case "not":
            record({ value: node, allowed: ["kind", "condition"] });
            condition({ node: node.condition, schema: schema, state: state, depth: depth + 1 });
            return;
        case "attribute":
            attribute(node, schema);
            return;
        case "event":
            event(node, schema);
            return;
        default: throw new SegmentCompileError({ code: "INVALID_INPUT", message: "Unsupported condition kind" });
    }
}
/** Validate application mappings before any SQL construction. @complexity O(mapped attributes) time/space, capped at 1000.  */
function validateSchema(schema: SegmentSchema): void {
    record({ value: schema, allowed: ["subjects", "attributes", "events"] });
    record({ value: schema.subjects, allowed: ["table", "idColumn", "tenantColumn", "workspaceColumn"] });
    for (const key of ["table", "idColumn", "tenantColumn", "workspaceColumn"] as const)
        quoteIdentifier({ value: schema.subjects[key] });
    if (!schema.attributes || typeof schema.attributes !== "object" || Array.isArray(schema.attributes))
        throw new SegmentCompileError({ code: "INVALID_SCHEMA", message: "Attribute mapping is required" });
    const keys = Object.keys(schema.attributes);
    if (keys.length > 1000)
        throw new SegmentCompileError({ code: "LIMIT_EXCEEDED", message: "Too many mapped attributes" });
    for (const key of keys)
        validateMapping({ key: key, schema: schema });
    if (schema.events)
        validateEventsMapping({ events: schema.events });
}
/** Validate one mapped attribute and reject accessor mappings. @complexity O(identifier length) time, O(1) space.  */
function validateMapping({ key, schema }: {
    key: string;
    schema: SegmentSchema;
}): void {
    text({ value: key });
    const mapping = attributeMapping({ name: key, schema: schema });
    record({ value: mapping, allowed: ["column", "type"] });
    quoteIdentifier({ value: mapping.column });
    if (!TYPES.includes(mapping.type))
        throw new SegmentCompileError({ code: "INVALID_SCHEMA", message: "Unsupported attribute type" });
}
/** Validate all required event identifiers. @complexity O(identifier length) time, O(1) space.  */
function validateEventsMapping({ events }: { events: NonNullable<SegmentSchema["events"]> }): void {
    record({ value: events, allowed: ["table", "subjectColumn", "tenantColumn", "workspaceColumn", "nameColumn", "occurredAtColumn"] });
    for (const key of ["table", "subjectColumn", "tenantColumn", "workspaceColumn", "nameColumn", "occurredAtColumn"] as const)
        quoteIdentifier({ value: events[key] });
}
/** Validate the whole boundary; no SQL is returned for partially valid input. @complexity O(nodes + mappings + scalar bytes) time, O(depth + mappings) space.  */
export function validateInput(input: CompileSegmentInput): void {
    record({ value: input, allowed: ["definition", "tenantId", "workspaceId", "schema"] });
    text({ value: input.tenantId });
    if (!input.tenantId.trim())
        throw new SegmentCompileError({ code: "INVALID_INPUT", message: "Tenant is required" });
    text({ value: input.workspaceId });
    if (!input.workspaceId.trim())
        throw new SegmentCompileError({ code: "INVALID_INPUT", message: "Workspace is required" });
    record({ value: input.definition, allowed: ["id", "version", "languageVersion", "condition"] });
    text({ value: input.definition.id });
    if (input.definition.languageVersion !== 1 || !Number.isSafeInteger(input.definition.version) || input.definition.version < 1)
        throw new SegmentCompileError({ code: "INVALID_INPUT", message: "Unsupported definition version" });
    validateSchema(input.schema);
    condition({ node: input.definition.condition, schema: input.schema, state: { nodes: 0 }, depth: 1 });
}
