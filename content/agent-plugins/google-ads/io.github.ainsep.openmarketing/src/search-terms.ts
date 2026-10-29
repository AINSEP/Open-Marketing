import { z } from "zod";
import { epochSchema, metricBatchSchema, metricValuesSchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, ClockPort, Outcome } from "@open-marketing/contracts";
import { decimalMicros, integerText, metricSearchRows } from "./metrics.ts";
import { asRecord } from "./readback.ts";
import { failure } from "./schema.ts";
import type { AccountBinding, GoogleTransportPort } from "./types.ts";

const numericId = z.string().min(1).max(19).regex(/^[1-9][0-9]*$/);
const daysSchema = metricBatchSchema.shape.days.refine(days => days.start < days.end && Date.parse(days.end) - Date.parse(days.start) <= 31 * 86400000);
/** Campaign-required, half-open account-local dates, at most 31 days. */
export const searchTermsInputSchema = z.strictObject({ campaignId: numericId, days: daysSchema });
const rowSchema = z.strictObject({
  campaignId: numericId, adGroupId: numericId, searchTerm: z.string().min(1).max(4096),
  status: z.enum(["ADDED", "ADDED_EXCLUDED", "EXCLUDED", "NONE", "UNKNOWN", "UNSPECIFIED"]),
  spendMicros: metricValuesSchema.shape.spend.unwrap(), clicks: metricValuesSchema.shape.clicks.unwrap(),
  impressions: metricValuesSchema.shape.impressions.unwrap(), vendorConversions: metricValuesSchema.shape.vendorConversions.unwrap(),
});
/** Served cost is integer currency micros; vendorConversions is integer millionths.
 * Missing metrics stay null. Google omits some low-volume terms even without truncation.
 */
export const searchTermsReportSchema = z.strictObject({
  currency: metricBatchSchema.shape.currency, timezone: metricBatchSchema.shape.timezone,
  retrievedAt: epochSchema, days: daysSchema, truncated: z.boolean(), rows: z.array(rowSchema).max(50),
});

/** Read one campaign's top reported terms, aggregated over the requested period.
 * Returns typed validation/transport failures; never fetches a continuation page.
 * @example searchTermsReport({ binding, transport, clock, context, operationId, input: { campaignId: "201", days } })
 * @complexity O(n) time/space, <=1,000 decoded rows under the shared 1MiB bound; query requests 51.
 */
export async function searchTermsReport(required: {
  binding: AccountBinding; transport: GoogleTransportPort; clock: ClockPort; context: CallContext; operationId: string; input: unknown;
}): Promise<Outcome<z.infer<typeof searchTermsReportSchema>>> {
  const input = parseBoundary({ schema: searchTermsInputSchema, input: required.input });
  if (!input.ok) return input;
  const { campaignId, days } = input.value;
  const response = await required.transport.request({ method: "search", context: required.context, operationId: required.operationId,
    body: { query: `SELECT campaign.id, ad_group.id, search_term_view.search_term, search_term_view.status, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions FROM search_term_view WHERE campaign.id = ${campaignId} AND segments.date >= '${days.start}' AND segments.date < '${days.end}' ORDER BY metrics.cost_micros DESC LIMIT 51` } });
  if (!response.ok) return response;
  const page = metricSearchRows({ value: response.value });
  if (!page.ok) return page;
  if (page.value.rows.some(row => asRecord({ value: row.campaign }).id !== campaignId)) return failure({ code: "forbidden", message: "Foreign Google search-term campaign" });
  const rows = parseBoundary({ schema: z.array(rowSchema), input: page.value.rows.map(row => searchTermRow({ row })) });
  if (!rows.ok) return rows;
  return parseBoundary({ schema: searchTermsReportSchema, input: {
    currency: required.binding.currency, timezone: required.binding.timezone, retrievedAt: required.clock.now({}), days,
    truncated: rows.value.length > 50 || !page.value.complete, rows: rows.value.slice(0, 50),
  } });
}

/** Project only selected fields; malformed metric objects fail the output schema.
 * O(1) per bounded row; shared decoders preserve exact integers and missing values.
 */
function searchTermRow({ row }: { row: Record<string, unknown> }): unknown {
  const metrics = asRecord({ value: row.metrics });
  if (row.metrics !== undefined && (row.metrics === null || typeof row.metrics !== "object" || Array.isArray(row.metrics))) return null;
  const term = asRecord({ value: row.searchTermView });
  return {
    campaignId: asRecord({ value: row.campaign }).id, adGroupId: asRecord({ value: row.adGroup }).id,
    searchTerm: term.searchTerm, status: term.status, spendMicros: integerText({ value: metrics.costMicros }),
    clicks: integerText({ value: metrics.clicks }), impressions: integerText({ value: metrics.impressions }),
    vendorConversions: decimalMicros({ value: metrics.conversions }),
  };
}
