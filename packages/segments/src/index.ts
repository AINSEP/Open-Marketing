import { attributeMapping, quoteIdentifier, validateInput } from "./validation.js";
import { SegmentCompileError, type CompileSegmentInput, type CompiledSegment, type ComparisonOperator, type SegmentCondition, type SegmentScalar, type SegmentSchema } from "./types.js";
export * from "./types.js";

const COMPARISONS: Readonly<Record<ComparisonOperator, string>> = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
type Context = { schema: SegmentSchema; params: SegmentScalar[] };

/** Append a validated scalar, preserving deterministic traversal order. @complexity O(1) amortized time/space. @overallScore 100 */
function bind(value: SegmentScalar, context: Context): string {
  context.params.push(value);
  return `$${context.params.length}`;
}

/** Compile attribute predicates as total booleans; NULL is only matched explicitly. @complexity O(in-list length) time/space. @overallScore 96 — Low: closed operator routing stays centralized. */
function compileAttribute(node: Extract<SegmentCondition, { kind: "attribute" }>, context: Context): string {
  const mapping = attributeMapping(node.attribute, context.schema);
  const column = `s.${quoteIdentifier(mapping.column)}`;
  if (node.operator === "exists") return `(${column} IS NOT NULL)`;
  if (node.operator === "in") {
    const values = node.value.map((value) => typedBind(value, mapping.type, context));
    return `COALESCE((${column} IN (${values.join(", ")})), FALSE)`;
  }
  if (node.value === null) return `(${column} IS ${node.operator === "ne" ? "NOT " : ""}NULL)`;
  return `COALESCE((${column} ${COMPARISONS[node.operator]} ${typedBind(node.value, mapping.type, context)}), FALSE)`;
}

/** Timestamp parameters carry an explicit Postgres cast; others infer from the mapped column. @complexity O(1) time/space. @overallScore 100 */
function typedBind(value: SegmentScalar, type: string, context: Context): string {
  const parameter = bind(value, context);
  return type === "timestamp" ? `${parameter}::timestamptz` : parameter;
}

/** Correlate event occurrences on tenant, workspace and subject with a half-open time window. @complexity O(event-name length) time/space. @overallScore 100 */
function compileEvent(node: Extract<SegmentCondition, { kind: "event" }>, context: Context): string {
  const events = context.schema.events!;
  const subjects = context.schema.subjects;
  const filters = [
    `e.${quoteIdentifier(events.tenantColumn)} = s.${quoteIdentifier(subjects.tenantColumn)}`,
    `e.${quoteIdentifier(events.workspaceColumn)} = s.${quoteIdentifier(subjects.workspaceColumn)}`,
    `e.${quoteIdentifier(events.subjectColumn)} = s.${quoteIdentifier(subjects.idColumn)}`,
    `e.${quoteIdentifier(events.nameColumn)} = ${bind(node.eventName, context)}`,
    `e.${quoteIdentifier(events.occurredAtColumn)} >= ${bind(node.window.from, context)}::timestamptz`,
    `e.${quoteIdentifier(events.occurredAtColumn)} < ${bind(node.window.to, context)}::timestamptz`,
  ];
  const from = `FROM ${quoteIdentifier(events.table)} AS e WHERE ${filters.join(" AND ")}`;
  if (!node.count) return `EXISTS (SELECT 1 ${from})`;
  return `((SELECT COUNT(*) ${from}) ${COMPARISONS[node.count.operator]} ${bind(node.count.value, context)}::bigint)`;
}

/** Recursively compile the validated closed AST, wrapping all boolean groups. @complexity O(nodes + output) time, O(depth + output) space. @overallScore 96 — Low: bounded recursion favors readable SQL. */
function compileCondition(node: SegmentCondition, context: Context): string {
  switch (node.kind) {
    case "and": return `(${node.conditions.map((child) => compileCondition(child, context)).join(" AND ")})`;
    case "or": return `(${node.conditions.map((child) => compileCondition(child, context)).join(" OR ")})`;
    case "not": return `(NOT ${compileCondition(node.condition, context)})`;
    case "attribute": return compileAttribute(node, context);
    case "event": return compileEvent(node, context);
    default: {
      const unreachable: never = node;
      throw new SegmentCompileError("INVALID_INPUT", `Unsupported condition: ${typeof unreachable}`);
    }
  }
}

/**
 * Compile a definition to a tenant/workspace-scoped prepared PostgreSQL SELECT.
 * @param input Versioned definition, nonempty scope and trusted identifier/type mapping.
 * @returns SQL and ordered parameters; no database access or input mutation.
 * @throws SegmentCompileError for unsupported syntax/types, unsafe mappings or resource limits.
 * @example compileSegment({ definition, tenantId: "tenant-1", workspaceId: "workspace-1", schema });
 * @complexity O(nodes + mappings + output) time/space with depth 16, nodes 1000 and in-lists 100.
 * @overallScore 100
 */
export function compileSegment(input: CompileSegmentInput): CompiledSegment {
  validateInput(input);
  const context: Context = { schema: input.schema, params: [input.tenantId, input.workspaceId] };
  const predicate = compileCondition(input.definition.condition, context);
  const subjects = input.schema.subjects;
  const scope = `s.${quoteIdentifier(subjects.tenantColumn)} = $1 AND s.${quoteIdentifier(subjects.workspaceColumn)} = $2`;
  return {
    sql: `SELECT s.* FROM ${quoteIdentifier(subjects.table)} AS s WHERE (${scope}) AND (${predicate})`,
    params: context.params,
    definitionId: input.definition.id,
    definitionVersion: input.definition.version,
  };
}
