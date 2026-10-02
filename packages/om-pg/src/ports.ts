/** Minimal result shape compatible with node-postgres, without a driver dependency. */
export interface QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
}

/** Inject a pg-compatible client; values are always parameterized separately from SQL. */
export interface PgQueryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string, values?: unknown[],
  ): Promise<QueryResult<Row>>;
}

/** A checked-out connection. release(true) must evict an unusable connection. */
export interface PgClient extends PgQueryable { release(destroy?: boolean): void; }

/** Caller owns pool construction, connection timeout, shutdown and credentials. */
export interface PgPool { connect(): Promise<PgClient>; }

/** Low-cardinality lifecycle signals. SQL, parameters and driver errors are never emitted. */
export interface PgEvent {
  operation: 'connect' | 'query' | 'release';
  status: 'started' | 'succeeded' | 'failed';
}

/** Nonblocking telemetry sink; thrown sink errors cannot change database semantics. */
export type PgObserver = (event: PgEvent) => void;

/** Typed failures preserve original causes for the trusted application boundary. */
export class PgFoundationError extends Error {
  constructor(public readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PgFoundationError';
  }
}
