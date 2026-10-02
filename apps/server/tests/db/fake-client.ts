import type { PgClient, PgPool, QueryResult } from '../../src/platform/jini-compat/db/src/ports.js';
/** Scriptable connection seam; it does not simulate PostgreSQL locking or constraints. */
export class FakeClient implements PgClient {
    statements: {
        text: string;
        values: unknown[];
    }[] = [];
    releases: (boolean | undefined)[] = [];
    failures = new Map<string, Error>();
    rows: Record<string, unknown>[] = [];
    pool: PgPool = { connect: async () => this };
    async query<Row extends Record<string, unknown> = Record<string, unknown>>({ text, values = [] }: {
        text: string;
        values?: unknown[];
    }): Promise<QueryResult<Row>> {
        this.statements.push({ text, values });
        const failure = this.failures.get(text);
        if (failure)
            throw failure;
        return { rows: this.rows as Row[], rowCount: this.rows.length };
    }
    release({ destroy }: {
        destroy?: boolean;
    }): void { this.releases.push(destroy); }
}
