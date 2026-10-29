import { gunzipSync } from "node:zlib";
import { z } from "zod";
import type { Outcome } from "@open-marketing/contracts";
import { failure } from "./ports.js";

import { dateSchema, presets } from "./commands.js";
export { dateSchema, presets } from "./commands.js";
const configuration = z.object({ adProduct: z.string(), groupBy: z.array(z.string()).max(4), columns: z.array(z.string()).max(32), reportTypeId: z.enum(["spCampaigns", "sbPurchasedProduct"]), timeUnit: z.literal("DAILY"), format: z.literal("GZIP_JSON"), filters: z.null().optional() });
/** Private location is consumed internally and stripped from all public status results. */
export const reportSchema = z.object({ reportId: z.string().uuid(), startDate: dateSchema, endDate: dateSchema, status: z.enum(["PENDING", "COMPLETED"]), configuration, url: z.string().max(16384).nullable(), urlExpiresAt: z.iso.datetime({ offset: true }).nullable() })
  .refine(value => value.endDate >= value.startDate);
export type Report = z.infer<typeof reportSchema>;

/** Verify supported configuration, rather than interpreting an unrelated report as a preset.
 * @complexity O(c), c<=32 columns. Vendor-only lifecycle states fail closed pending evidence.
 */
export function supportedReport(required: { report: Report }): boolean {
  const actual = required.report.configuration;
  const preset = presets[actual.reportTypeId];
  return actual.adProduct === preset.adProduct && JSON.stringify(actual.groupBy) === JSON.stringify(preset.groupBy)
    && JSON.stringify(actual.columns) === JSON.stringify(preset.columns);
}

/** Stream cap applies even without Content-Length. Cancels oversized/unread streams.
 * @param required - Response and byte cap. @returns Bytes or a redacted limit/transport error.
 * @complexity O(b) time/space, b<=the fixed caller cap; no unbounded buffering.
 */
export async function readBytes(required: { response: Response; max: number }): Promise<Outcome<Buffer>> {
  if (!required.response.body) return failure({ code: "protocol_mismatch" });
  const reader = required.response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return { ok: true, value: Buffer.concat(chunks) };
      size += chunk.value.byteLength;
      if (size > required.max) return failure({ code: "limit_exceeded" });
      chunks.push(chunk.value);
    }
  } catch { return failure({ code: "unavailable" }); }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Signed locations require scoped status, current expiry, HTTPS and the exact official example host.
 * This is an egress destination check, not a plugin admission/allowlist mechanism. @complexity O(u).
 */
export function downloadLocation(required: { report: Report; now: number }): Outcome<string> {
  const { report, now } = required;
  if (report.status !== "COMPLETED" || !report.url || !report.urlExpiresAt) return failure({ code: "unavailable" });
  if (!Number.isSafeInteger(now) || Date.parse(report.urlExpiresAt) <= now) return failure({ code: "expired" });
  try {
    const url = new URL(report.url);
    if (!plainHttps({ url })) return failure({ code: "protocol_mismatch" });
    if (url.hostname !== "offline-report-storage-us-east-1-prod.s3.amazonaws.com") return failure({ code: "unavailable" });
    return { ok: true, value: url.href };
  } catch { return failure({ code: "protocol_mismatch" }); }
}
function plainHttps(required: { url: URL }): boolean { const url = required.url; return url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash; }
const identifier = z.union([z.string().regex(/^[1-9][0-9]{0,19}$/), z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String)]);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const metric = z.number().finite().nonnegative();
const text = z.string().max(1024);
const spRow = z.object({ campaignId: identifier, adGroupId: identifier, date: dateSchema, impressions: count, clicks: count, cost: metric });
const sbRow = z.object({ campaignName: text, adGroupName: text, purchasedAsin: z.string().regex(/^[A-Za-z0-9]{10}$/), productName: text, date: dateSchema, sales14d: metric, orders14d: count });

/** Decode one gzip JSON array; 1MiB compressed, 8MiB decoded, 10,000 rows. Reject mixed-invalid
 * batches atomically; row dates must belong to the scoped report. No raw provider fields escape.
 * @complexity O(b+n) time/space within the fixed byte and row caps.
 */
export function decodeDownload(required: { bytes: Buffer; report: Report }): Outcome<unknown> {
  if (required.bytes.length > 1048576) return failure({ code: "limit_exceeded" });
  try {
    const decoded = gunzipSync(required.bytes, { maxOutputLength: 8388608 });
    const schema = required.report.configuration.reportTypeId === "spCampaigns" ? z.array(spRow).max(10000) : z.array(sbRow).max(10000);
    const rows = schema.safeParse(JSON.parse(decoded.toString("utf8")) as unknown);
    if (!rows.success) return failure({ code: "protocol_mismatch" });
    if (rows.data.some(row => row.date < required.report.startDate || row.date > required.report.endDate)) return failure({ code: "protocol_mismatch" });
    return { ok: true, value: { reportId: required.report.reportId, startDate: required.report.startDate, endDate: required.report.endDate, rows: rows.data } };
  } catch { return failure({ code: "protocol_mismatch" }); }
}
