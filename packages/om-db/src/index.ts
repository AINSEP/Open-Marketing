/** Checked SQLite bridge over an injected native handle and its owning Jini kernel. */
export * from './ports.js';
export * from './transaction.js';
export { createCheckedSqliteClient, createSqlitePool, type SqlitePool } from './sqlite.js';
