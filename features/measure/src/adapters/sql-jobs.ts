import type { ObserverPort } from "@open-marketing/contracts";
import type { MeasureJobPort, MeasureSqlDatabase, MeasureTransactionalJobPort } from "../ports.js";
import { ingestionContext, parseSourceEvent } from "../rules.js";
import { sqlBoundary, unwrap } from "./sql-boundary.js";

/** Standalone jobs boundary adapter. Ingestion uses createSqlMeasureRepo's transaction
 * binding instead; this adapter never creates a feature-owned jobs table.
 * @example createSqlMeasureJob({ database, jobs }) */
export function createSqlMeasureJob(required: { database: MeasureSqlDatabase; jobs: MeasureTransactionalJobPort }, optional?: { observer?: ObserverPort }): MeasureJobPort {
  return {
    async enqueue(input, options) {
      const parsed = parseSourceEvent({ input });
      if (!parsed.ok) return parsed;
      const context = ingestionContext(parsed.value);
      return sqlBoundary({ context, operation: "measure.sql.enqueue", observer: optional?.observer, work: () => required.database.transaction({ work: async ({ session: transaction }) => unwrap({ outcome: await required.jobs.enqueue({ transaction, context, source: parsed.value.source, event: parsed.value.event }, options) }) }) }, options);
    },
  };
}
