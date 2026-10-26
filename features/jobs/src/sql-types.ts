import type { SqlSession, UnitOfWork } from "@open-marketing/contracts";
/** Canonical leased SQL session; all values use bound $n parameters. */
export type JobsSqlSession = SqlSession;
/** Server owns serialization, rollback-on-denial and session lifetime. */
export type JobsSqlDatabase = UnitOfWork;
