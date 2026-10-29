import type { SqlSession } from "@open-marketing/contracts";

/** Canonical SQL session; rows remain validated at the repository boundary. */
export type WorkspaceSqlSession = SqlSession;
/** Server owns transaction serialization and leased-session lifetime. */
export type WorkspaceSqlDatabase = SqlSession;
