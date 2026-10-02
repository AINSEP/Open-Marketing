import { parseBoundary } from "@open-marketing/contracts";
import type { MeasureJobPort, MeasureObserverPort, MeasureSqlDatabase, MeasureTransactionalJobPort } from "../ports.js";
import { conversionSchema, ingestionContext, sourceSchema } from "../rules.js";
import { sqlBoundary, unwrap } from "./sql-boundary.js";

/** Standalone jobs boundary adapter. Ingestion uses createSqlMeasureRepo's transaction
 * binding instead; this adapter never creates a feature-owned jobs table.
 * @example createSqlMeasureJob({ database, jobs }) */
export function createSqlMeasureJob(required: { database: MeasureSqlDatabase; jobs: MeasureTransactionalJobPort }, optional?: { observer?: MeasureObserverPort }): MeasureJobPort {
  return {
    async enqueue(input, options) {
      const source = parseBoundary({ schema: sourceSchema, input: input.source });
      if (!source.ok) return source;
      const event = parseBoundary({ schema: conversionSchema, input: input.event });
      if (!event.ok) return event;
      const context = ingestionContext({ source: source.value, event: event.value });
      return sqlBoundary({ context, operation: "measure.sql.enqueue", observer: optional?.observer, work: () => required.database.transaction({ work: async transaction => unwrap({ outcome: await required.jobs.enqueue({ transaction, context, source: source.value, event: event.value }, options) }) }) }, options);
    },
  };
}
