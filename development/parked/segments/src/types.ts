/** Public scalar types supported by the condition language. Timestamps are ISO UTC strings. */
export type AttributeType = "string" | "number" | "boolean" | "timestamp";
/** Finite scalar SQL bind values. */
export type SegmentScalar = string | number | boolean;
/** Closed comparison vocabulary; arbitrary SQL operators are never accepted. */
export type ComparisonOperator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
/** Version-one segment language with explicit event windows and bounded logical composition. */
export type SegmentCondition = {
    readonly kind: "and" | "or";
    readonly conditions: readonly SegmentCondition[];
} | {
    readonly kind: "not";
    readonly condition: SegmentCondition;
} | {
    readonly kind: "attribute";
    readonly attribute: string;
    readonly operator: ComparisonOperator;
    readonly value: SegmentScalar | null;
} | {
    readonly kind: "attribute";
    readonly attribute: string;
    readonly operator: "in";
    readonly value: readonly SegmentScalar[];
} | {
    readonly kind: "attribute";
    readonly attribute: string;
    readonly operator: "exists";
} | {
    readonly kind: "event";
    readonly eventName: string;
    readonly window: {
        readonly from: string;
        readonly to: string;
    };
    readonly count?: {
        readonly operator: ComparisonOperator;
        readonly value: number;
    };
};
/** Persistable definition identity; publication and storage immutability belong to the caller. */
export interface SegmentDefinition {
    readonly id: string;
    readonly version: number;
    readonly languageVersion: 1;
    readonly condition: SegmentCondition;
}
/** Trusted application mapping; identifiers are still validated and quoted. No raw SQL fields. */
export interface SegmentSchema {
    readonly subjects: {
        readonly table: string;
        readonly idColumn: string;
        readonly tenantColumn: string;
        readonly workspaceColumn: string;
    };
    readonly attributes: Readonly<Record<string, {
        readonly column: string;
        readonly type: AttributeType;
    }>>;
    readonly events?: {
        readonly table: string;
        readonly subjectColumn: string;
        readonly tenantColumn: string;
        readonly workspaceColumn: string;
        readonly nameColumn: string;
        readonly occurredAtColumn: string;
    };
}
/** Required tenant scope and explicit schema; the compiler makes no database calls. */
export interface CompileSegmentInput {
    readonly definition: SegmentDefinition;
    readonly tenantId: string;
    readonly workspaceId: string;
    readonly schema: SegmentSchema;
}
/** Stable prepared query and bind order, including tenant as parameter one. */
export interface CompiledSegment {
    readonly sql: string;
    readonly params: readonly SegmentScalar[];
    readonly definitionId: string;
    readonly definitionVersion: number;
}
/** Typed validation failure; values and tenant identifiers are omitted from error messages. */
export class SegmentCompileError extends Error {
    readonly code: "INVALID_INPUT" | "INVALID_SCHEMA" | "UNKNOWN_ATTRIBUTE" | "UNSUPPORTED_OPERATOR" | "TYPE_MISMATCH" | "LIMIT_EXCEEDED";
    constructor({ code, message }: {
        code: "INVALID_INPUT" | "INVALID_SCHEMA" | "UNKNOWN_ATTRIBUTE" | "UNSUPPORTED_OPERATOR" | "TYPE_MISMATCH" | "LIMIT_EXCEEDED";
        message: string;
    }) {
        super(message);
        this.code = code;
        this.name = "SegmentCompileError";
    }
}
