import { z } from "zod";
import { callContextSchema, idSchema } from "@open-marketing/contracts";
/** Real ISO days, without normalizing impossible calendar dates. */
export const dateSchema = z.iso.date();
/** Fixed verified presets; no arbitrary columns, filters or SB spend claims. */
export const presets = {
  spCampaigns: { adProduct: "SPONSORED_PRODUCTS", groupBy: ["campaign", "adGroup"], columns: ["adGroupId", "campaignId", "impressions", "clicks", "cost", "date"], reportTypeId: "spCampaigns", timeUnit: "DAILY", format: "GZIP_JSON" },
  sbPurchasedProduct: { adProduct: "SPONSORED_BRANDS", groupBy: ["purchasedAsin"], columns: ["adGroupName", "campaignName", "purchasedAsin", "productName", "sales14d", "orders14d", "date"], reportTypeId: "sbPurchasedProduct", timeUnit: "DAILY", format: "GZIP_JSON" },
} as const;

/** Decimal provider identifiers remain strings; unsafe numeric IDs reject at the boundary. */
export const vendorIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/);
export const providerIdSchema = z.union([vendorIdSchema, z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String)]);
const token = z.string().min(1).max(2048).regex(/^[\x21-\x7e]+$/);
const reportId = z.string().uuid();
/** Closed R1 surface; report dates are inclusive calendar days, at most 31 days (OM limit). */
export const commandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("list_accounts") }),
  z.strictObject({ kind: z.literal("list_campaigns"), adProduct: z.enum(["SP", "SB"]), maxResults: z.number().int().min(1).max(100).default(100), nextToken: token.optional() }),
  z.strictObject({ kind: z.literal("request_report"), preset: z.enum(["spCampaigns", "sbPurchasedProduct"]), startDate: dateSchema, endDate: dateSchema })
    .refine(value => value.endDate >= value.startDate && Date.parse(value.endDate) - Date.parse(value.startDate) < 31 * 86400000),
  z.strictObject({ kind: z.literal("get_report"), reportId }),
  z.strictObject({ kind: z.literal("download_report"), reportId }),
]);
/** Public callers can omit maxResults; parsing fills the bounded default. */
export type AmazonCommand = z.input<typeof commandSchema>;
export type ParsedCommand = z.output<typeof commandSchema>;
/** Host invocation parser; no caller-controlled account, origin, auth or write status. */
export const invocationSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, command: commandSchema });
/** Host catalog uses this classification even when a read endpoint uses POST. */
export const amazonAdsTools = commandSchema.options.map(schema => ({ name: schema.shape.kind.value, inputSchema: schema, effect: schema.shape.kind.value === "request_report" ? "write" as const : "read" as const }));

/** Fixed vendor mappings, no I/O. @complexity O(b), b<=64KiB at invocation boundary. */
export function encodeCommand(required: { command: ParsedCommand }): { path: string; method: "GET" | "POST"; media: string; body?: string } {
  const command = required.command;
  switch (command.kind) {
    case "list_accounts": return { path: "/v2/profiles", method: "GET", media: "application/json" };
    case "list_campaigns": return {
      path: command.adProduct === "SP" ? "/sp/campaigns/list" : "/sb/v4/campaigns/list", method: "POST",
      media: command.adProduct === "SP" ? "application/vnd.spCampaign.v3+json" : "application/vnd.sbcampaignresource.v4+json",
      body: JSON.stringify({ maxResults: command.maxResults, nextToken: command.nextToken }),
    };
    case "request_report": return { path: "/reporting/reports", method: "POST", media: "application/vnd.createasyncreportrequest.v3+json", body: JSON.stringify({ startDate: command.startDate, endDate: command.endDate, configuration: presets[command.preset] }) };
    case "get_report": case "download_report": return { path: "/reporting/reports/" + command.reportId, method: "GET", media: "application/vnd.getasyncreportresponse.v3+json" };
    default: { const exhaustive: never = command; return exhaustive; }
  }
}
