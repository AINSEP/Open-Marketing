import { describe, expect, it } from "vitest";
import { compileSegment, SegmentCompileError, type CompileSegmentInput, type SegmentCondition, type SegmentSchema } from "../src/index.js";

const schema: SegmentSchema = {
  subjects: { table: "subjects", idColumn: "id", tenantColumn: "tenant_id", workspaceColumn: "workspace_id" },
  attributes: { name: { column: "display_name", type: "string" }, age: { column: "age", type: "number" }, active: { column: "active", type: "boolean" }, joined: { column: "joined_at", type: "timestamp" } },
  events: { table: "events", subjectColumn: "subject_id", tenantColumn: "tenant_id", workspaceColumn: "workspace_id", nameColumn: "name", occurredAtColumn: "occurred_at" },
};
const leaf: SegmentCondition = { kind: "attribute", attribute: "age", operator: "gte", value: 18 };
const window = { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" };
const input = (condition: SegmentCondition = leaf): CompileSegmentInput => ({ definition: { id: "adult", version: 3, languageVersion: 1, condition }, tenantId: "t1", workspaceId: "w1", schema });

describe("deterministic prepared SQL", () => {
  it("binds scope first and preserves version without mutation", () => {
    const value = input();
    const before = structuredClone(value);
    const query = compileSegment(value);
    expect(query).toEqual(compileSegment(value));
    expect(value).toEqual(before);
    expect(query).toEqual({
      definitionId: "adult", definitionVersion: 3,
      sql: 'SELECT s.* FROM "subjects" AS s WHERE (s."tenant_id" = $1 AND s."workspace_id" = $2) AND (COALESCE((s."age" >= $3), FALSE))',
      params: ["t1", "w1", 18],
    });
  });

  it("keeps injection strings in parameters and tenant restriction outside boolean trees", () => {
    const attack = "x' OR TRUE; DROP TABLE subjects; --";
    const query = compileSegment({ ...input({ kind: "or", conditions: [
      { kind: "attribute", attribute: "name", operator: "eq", value: attack },
      { kind: "not", condition: leaf },
    ] }), tenantId: attack });
    expect(query.sql).not.toContain(attack);
    expect(query.params).toEqual([attack, "w1", attack, 18]);
    expect(query.sql).toContain('WHERE (s."tenant_id" = $1 AND s."workspace_id" = $2) AND ((');
    expect(query.sql).toContain(" OR (NOT COALESCE(");
  });

  it("retains depth-first stable parameter order across repeated values", () => {
    const query = compileSegment(input({ kind: "and", conditions: [leaf, { kind: "attribute", attribute: "age", operator: "in", value: [18, 21, 18] }] }));
    expect(query.params).toEqual(["t1", "w1", 18, 18, 21, 18]);
    expect(query.sql).toContain("IN ($4, $5, $6)");
  });

  it.each(["eq", "ne", "gt", "gte", "lt", "lte"] as const)("supports numeric operator %s", (operator) => {
    expect(compileSegment(input({ kind: "attribute", attribute: "age", operator, value: 4 })).params).toEqual(["t1", "w1", 4]);
  });

  it("casts timestamp values explicitly and accepts boolean equality", () => {
    const query = compileSegment(input({ kind: "and", conditions: [
      { kind: "attribute", attribute: "joined", operator: "gte", value: window.from },
      { kind: "attribute", attribute: "active", operator: "eq", value: false },
    ] }));
    expect(query.sql).toContain("$3::timestamptz");
    expect(query.params).toEqual(["t1", "w1", window.from, false]);
  });
});

describe("null and negation semantics", () => {
  it.each([["eq", "IS NULL"], ["ne", "IS NOT NULL"]] as const)("uses explicit %s-null predicate", (operator, expected) => {
    const query = compileSegment(input({ kind: "attribute", attribute: "name", operator, value: null }));
    expect(query.sql).toContain(`s."display_name" ${expected}`);
    expect(query.params).toEqual(["t1", "w1"]);
  });
  it("exists means non-null and not-exists means SQL null", () => {
    const query = compileSegment(input({ kind: "not", condition: { kind: "attribute", attribute: "name", operator: "exists" } }));
    expect(query.sql).toContain('(NOT (s."display_name" IS NOT NULL))');
  });
  it("totalizes ordinary comparisons so NOT includes null rows", () => {
    const query = compileSegment(input({ kind: "not", condition: { kind: "attribute", attribute: "name", operator: "ne", value: "Ada" } }));
    expect(query.sql).toContain('(NOT COALESCE((s."display_name" <> $3), FALSE))');
  });
});

describe("events", () => {
  it("correlates all identity scopes and compiles a half-open caller window", () => {
    const query = compileSegment(input({ kind: "event", eventName: "purchase", window }));
    expect(query.params).toEqual(["t1", "w1", "purchase", window.from, window.to]);
    expect(query.sql).toContain('EXISTS (SELECT 1 FROM "events" AS e');
    for (const pair of ['e."tenant_id" = s."tenant_id"', 'e."workspace_id" = s."workspace_id"', 'e."subject_id" = s."id"']) expect(query.sql).toContain(pair);
    expect(query.sql).toContain('e."occurred_at" >= $4::timestamptz AND e."occurred_at" < $5::timestamptz');
  });
  it("supports zero-count matching and parameterizes count", () => {
    const query = compileSegment(input({ kind: "event", eventName: "purchase", window, count: { operator: "eq", value: 0 } }));
    expect(query.sql).toContain("SELECT COUNT(*)");
    expect(query.sql).toContain("= $6::bigint");
    expect(query.params.at(-1)).toBe(0);
  });
  it.each([
    { from: window.to, to: window.from }, { from: window.from, to: window.from },
    { from: "2026-02-30T00:00:00.000Z", to: window.to }, { from: "yesterday", to: "now" },
  ])("rejects invalid event window", (invalid) => {
    expect(() => compileSegment(input({ kind: "event", eventName: "purchase", window: invalid }))).toThrow(SegmentCompileError);
  });
  it.each([-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid occurrence count %s", (value) => {
    expect(() => compileSegment(input({ kind: "event", eventName: "purchase", window, count: { operator: "gte", value } }))).toThrow(SegmentCompileError);
  });
  it("requires an events mapping", () => {
    const value = input({ kind: "event", eventName: "purchase", window });
    expect(() => compileSegment({ ...value, schema: { subjects: schema.subjects, attributes: schema.attributes } })).toThrowError(expect.objectContaining({ code: "INVALID_SCHEMA" }));
  });
});

describe("validation and resource bounds", () => {
  it.each([
    { kind: "raw", sql: "TRUE" },
    { kind: "attribute", attribute: "name", operator: "eq", value: 12 },
    { kind: "attribute", attribute: "active", operator: "gt", value: true },
    { kind: "attribute", attribute: "age", operator: "eq", value: "18" },
    { kind: "attribute", attribute: "age", operator: "gt", value: null },
    { kind: "attribute", attribute: "age", operator: "in", value: [1, null] },
    { kind: "attribute", attribute: "name", operator: "eq" },
    { kind: "attribute", attribute: "name", operator: "exists", value: true },
    { kind: "attribute", attribute: "name", operator: "= $1 OR TRUE", value: "x" },
    { kind: "attribute", attribute: "name", operator: "eq", value: "x", sql: "OR TRUE" },
  ])("fails closed on unsupported AST %j", (condition) => {
    expect(() => compileSegment(input(condition as unknown as SegmentCondition))).toThrow(SegmentCompileError);
  });
  it("rejects unknown attributes rather than interpolating names", () => {
    expect(() => compileSegment(input({ kind: "attribute", attribute: 'name" OR TRUE --', operator: "eq", value: "x" }))).toThrowError(expect.objectContaining({ code: "UNKNOWN_ATTRIBUTE" }));
  });
  it("rejects dangerous schema identifiers and prototype attribute lookups", () => {
    expect(() => compileSegment({ ...input(), schema: { ...schema, subjects: { ...schema.subjects, table: 'subjects"; DROP TABLE x' } } })).toThrowError(expect.objectContaining({ code: "INVALID_SCHEMA" }));
    expect(() => compileSegment(input({ kind: "attribute", attribute: "toString", operator: "exists" }))).toThrowError(expect.objectContaining({ code: "UNKNOWN_ATTRIBUTE" }));
  });
  it.each(["", " "])("requires nonempty tenant and workspace", (scope) => {
    expect(() => compileSegment({ ...input(), tenantId: scope })).toThrow(SegmentCompileError);
    expect(() => compileSegment({ ...input(), workspaceId: scope })).toThrow(SegmentCompileError);
  });
  it("bounds nesting and handles cycles without stack exhaustion", () => {
    let condition = leaf;
    for (let i = 0; i < 15; i++) condition = { kind: "not", condition };
    expect(compileSegment(input(condition)).params).toEqual(["t1", "w1", 18]);
    expect(() => compileSegment(input({ kind: "not", condition }))).toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
    const cycle: { kind: "not"; condition?: unknown } = { kind: "not" }; cycle.condition = cycle;
    expect(() => compileSegment(input(cycle as SegmentCondition))).toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
  });
  it("bounds total nodes independently of depth and per-group length", () => {
    const group: SegmentCondition = { kind: "and", conditions: Array.from({ length: 100 }, () => leaf) };
    expect(() => compileSegment(input({ kind: "or", conditions: Array.from({ length: 10 }, () => group) }))).toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
  });
  it("bounds in-lists and rejects partial invalid lists", () => {
    const condition: SegmentCondition = { kind: "attribute", attribute: "age", operator: "in", value: Array.from({ length: 100 }, (_, i) => i) };
    expect(compileSegment(input(condition)).params).toHaveLength(102);
    expect(() => compileSegment(input({ ...condition, value: Array.from({ length: 101 }, () => 1) }))).toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
    expect(() => compileSegment(input({ ...condition, value: [] }))).toThrow(SegmentCompileError);
    expect(() => compileSegment(input({ ...condition, value: [1, 2, "3"] }))).toThrowError(expect.objectContaining({ code: "TYPE_MISMATCH" }));
  });
  it("rejects unsupported definition versions", () => {
    const value = input();
    expect(() => compileSegment({ ...value, definition: { ...value.definition, version: 0 } })).toThrow(SegmentCompileError);
    expect(() => compileSegment({ ...value, definition: { ...value.definition, languageVersion: 2 } } as unknown as CompileSegmentInput)).toThrow(SegmentCompileError);
  });
});
