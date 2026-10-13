import { z } from "zod";
import { callContextSchema, idSchema, parseBoundary } from "@open-marketing/contracts";
import type { IdPort } from "@open-marketing/contracts";
import type { MeasureObserverPort, MeasureSqlDatabase, TrackedLinkPort } from "../ports.js";
import { failure, linkRequestSchema, nextId, scopeKey } from "../rules.js";
import { prepareTrackedLink, validateTrackedDestination } from "../links/links.js";
import { sqlBoundary, unwrap } from "./sql-boundary.js";
const linkSchema = z.strictObject({ linkId: idSchema, url: z.string().max(4096), destinationUrl: z.string().max(4096), campaignId: idSchema });

/** Durable scoped redirect adapter; only stored validated destinations can redirect.
 * URL policy is applied again on read. No fetch or redirect chain is followed.
 * @example createSqlTrackedLink({ database, ids, baseUrl, allowedOrigins })
 * @complexity Indexed O(log n) storage plus bounded URL policy. */
export function createSqlTrackedLink(required: { database: MeasureSqlDatabase; ids: IdPort; baseUrl: string; allowedOrigins: readonly string[]; allowedQueryKeys?: readonly string[] }, optional?: { observer?: MeasureObserverPort }): TrackedLinkPort {
  return {
    async create(input, options) {
      const context = parseBoundary({ schema: callContextSchema, input: input.context });
      if (!context.ok) return context;
      const request = parseBoundary({ schema: linkRequestSchema, input: input.request });
      if (!request.ok) return request;
      const id = nextId({ ids: required.ids, fallback: "" });
      if (!id.ok) return id;
      const link = prepareTrackedLink({ linkId: id.value, request: request.value, baseUrl: required.baseUrl, allowedOrigins: required.allowedOrigins, allowedQueryKeys: required.allowedQueryKeys });
      if (!link.ok) return link;
      return sqlBoundary({ context: context.value, operation: "measure.sql.createLink", observer: optional?.observer, work: () => required.database.transaction({ work: async transaction => {
        const values = [scopeKey({ scope: context.value.scope }), link.value.linkId];
        const existing = await transaction.query({ text: "SELECT link_id FROM measure_tracked_link WHERE scope_key=$1 AND link_id=$2", values });
        if (existing.rows[0]) return unwrap({ outcome: failure({ code: "conflict", message: "Tracked link ID collision" }) });
        await transaction.query({ text: "INSERT INTO measure_tracked_link (scope_key,link_id,link_json) VALUES ($1,$2,$3)", values: [...values, JSON.stringify(link.value)] });
        return link.value;
      } }) }, options);
    },
    async resolve(input, options) {
      const context = parseBoundary({ schema: callContextSchema, input: input.context });
      if (!context.ok) return context;
      const linkId = parseBoundary({ schema: idSchema, input: input.linkId });
      if (!linkId.ok) return linkId;
      return sqlBoundary({ context: context.value, operation: "measure.sql.resolveLink", observer: optional?.observer, work: async () => {
        const result = await required.database.query({ text: "SELECT link_json FROM measure_tracked_link WHERE scope_key=$1 AND link_id=$2", values: [scopeKey({ scope: context.value.scope }), input.linkId] });
        if (!result.rows[0]) return unwrap({ outcome: failure({ code: "unavailable", message: "Tracked link not found" }) });
        const link = unwrap({ outcome: parseBoundary({ schema: linkSchema, input: JSON.parse(String(result.rows[0].link_json)) }) });
        unwrap({ outcome: validateTrackedDestination({ url: link.destinationUrl, allowedOrigins: required.allowedOrigins, allowedQueryKeys: required.allowedQueryKeys }) });
        return link;
      } }, options);
    },
  };
}
