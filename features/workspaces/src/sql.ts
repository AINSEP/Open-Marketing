import type { SqlSession } from "@open-marketing/contracts";
import { callPort } from "./boundary.js";
import { bindingSchema } from "./schemas.js";

/** Canonical SQL session; rows remain validated at the repository boundary. */
export type WorkspaceSqlSession = SqlSession;
/** Server owns transaction serialization and leased-session lifetime. */
export type WorkspaceSqlDatabase = SqlSession;
/** Use the persistent repository's same scoped lookup boundary. @complexity O(1).
 * @example createSqlAccountBindingLookup({ repo: sqlRepo })
 */
export function createSqlAccountBindingLookup(required: { repo: import("./ports.js").AccountBindingLookupPort }): import("./ports.js").AccountBindingLookupPort {
  return { async find(input, optional) { return callPort({ invoke: () => required.repo.find(input, optional), schema: bindingSchema.nullable() }, optional); } };
}
