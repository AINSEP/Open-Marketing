import type { ClockPort, IdPort } from "@open-marketing/contracts";
import type { JobRepoPort } from "./ports.js";
import type { OutboxEvent, RetryPolicy } from "./types.js";
import type { JobsSqlDatabase } from "./sql-types.js";
import { createSqlOutboxStore } from "./sql.js";
import { createJobRepository } from "./repository.js";
/** SQL service repository over the same durable outbox used by transactional domain writes.
 * @example createSqlJobRepo({ database, clock, ids, retryPolicy })
 * @complexity O(1) construction; operations inherit bounded repository/SQL work.
 */
export function createSqlJobRepo(required: { database: JobsSqlDatabase; clock: ClockPort; ids: IdPort; retryPolicy: RetryPolicy; maxJobs?: number; observe?: (event: OutboxEvent) => void }): JobRepoPort {
    return createJobRepository({ ...required, outbox: createSqlOutboxStore(required) });
}
