import { z } from "zod";
import { parseBoundary } from "@open-marketing/contracts";
import type { CallContext, Outcome } from "@open-marketing/contracts";
import { metricSearchRows } from "./metrics.ts";
import { failure, success } from "./schema.ts";
import type { AccountBinding, GoogleTransportPort } from "./types.ts";

const numericId = z.string().min(1).max(19).regex(/^[1-9][0-9]*$/);
const targetSchema = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("campaign"), campaignId: numericId }),
  z.strictObject({ scope: z.literal("ad_group"), campaignId: numericId, adGroupId: numericId }),
]);
// Reject control characters before normalization, so line breaks cannot become valid spaces.
const keywordText = z.string().regex(/^[^'"\\\p{Cc}\[\]+!@%\^*=<>;,{}|~]*$/u)
  .transform(text => text.trim().replace(/\s+/g, " ").toLowerCase())
  .pipe(z.string().min(1).max(80).refine(text => text.split(" ").length <= 10));
/** One EXACT exclusion; scope identities are numeric and text cannot inject GAQL. */
export const negativeKeywordInputSchema = z.strictObject({ target: targetSchema, text: keywordText });
/** A receipt acknowledges one criterion or preserves uncertainty; it never authorizes retry. */
export const negativeKeywordReceiptSchema = z.strictObject({
  status: z.enum(["created", "already_present", "unknown"]), resourceName: z.string().min(1).max(256).optional(),
  target: targetSchema, text: keywordText, matchType: z.literal("EXACT"),
});
type NegativeInput = z.infer<typeof negativeKeywordInputSchema>;
type NegativeReceipt = z.infer<typeof negativeKeywordReceiptSchema>;
type NegativeCall = { binding: AccountBinding; transport: GoogleTransportPort; context: CallContext; operationId: string; input: unknown };

/** Under the host's exact card/outbox/halt barrier: verify Search membership, look up
 * this exact negative, then send at most one create. Never retries or reads back a create.
 * @returns Typed pre-send/Google failures, an existing criterion, or created/unknown receipt.
 * @example addNegativeKeyword({ binding, transport, context, operationId, input: { target: { scope: "ad_group", campaignId: "201", adGroupId: "301" }, text: "free jobs" } })
 * @complexity O(1) bounded rows; two searches and <=1 mutation, using the existing 30s call deadline.
 */
export async function addNegativeKeyword(required: NegativeCall): Promise<Outcome<NegativeReceipt>> {
  const input = parseBoundary({ schema: negativeKeywordInputSchema, input: required.input });
  if (!input.ok) return input;
  const membership = await checkMembership({ ...required, target: input.value.target });
  if (!membership.ok) return membership;
  const criterion = criterionScope({ customerId: required.binding.customerId, target: input.value.target });
  const existing = await findNegative({ ...required, input: input.value, criterion });
  if (!existing.ok) return existing;
  if (existing.value !== null) return receipt({ input: input.value, status: "already_present", resourceName: existing.value });
  const response = await required.transport.request({ method: "mutate", context: required.context, operationId: required.operationId,
    body: { partialFailure: false, mutateOperations: [{ [criterion.field + "Operation"]: { create: {
      ...criterion.parent, negative: true, keyword: { text: input.value.text, matchType: "EXACT" },
    } } }] } });
  return mutationReceipt({ response, input: input.value, criterion });
}

/** Complete membership must identify exactly the requested Search campaign/ad group.
 * One search, <=2 rows; missing, foreign, duplicate or non-Search evidence denies writes.
 */
async function checkMembership(required: Omit<NegativeCall, "input"> & { target: NegativeInput["target"] }): Promise<Outcome<void>> {
  const { target } = required;
  const groupFields = target.scope === "ad_group" ? ", ad_group.id" : "";
  const source = target.scope === "ad_group" ? "ad_group" : "campaign";
  const groupFilter = target.scope === "ad_group" ? `ad_group.id = ${target.adGroupId} AND ` : "";
  const rows = await searchRows({ ...required, query: `SELECT campaign.id, campaign.advertising_channel_type${groupFields} FROM ${source} WHERE ${groupFilter}campaign.id = ${target.campaignId} LIMIT 2` });
  if (!rows.ok) return rows;
  const schema = z.object({ campaign: z.object({ id: z.literal(target.campaignId), advertisingChannelType: z.literal("SEARCH") }),
    ...(target.scope === "ad_group" ? { adGroup: z.object({ id: z.literal(target.adGroupId) }) } : {}),
  });
  if (rows.value.length !== 1 || !schema.safeParse(rows.value[0]).success) return failure({ code: "forbidden", message: "Google Search campaign/ad-group membership unavailable" });
  return success({ value: undefined });
}

/** The same two fixed criterion shapes drive lookup, create and ACK validation. Pure O(1). */
function criterionScope({ customerId, target }: { customerId: string; target: NegativeInput["target"] }) {
  if (target.scope === "ad_group") return {
    source: "ad_group_criterion", field: "adGroupCriterion", filter: `ad_group.id = ${target.adGroupId}`,
    parent: { adGroup: `customers/${customerId}/adGroups/${target.adGroupId}` },
    resourceName: z.string().max(256).regex(new RegExp(`^customers/${customerId}/adGroupCriteria/${target.adGroupId}~[0-9]+$`)),
  };
  return {
    source: "campaign_criterion", field: "campaignCriterion", filter: `campaign.id = ${target.campaignId}`,
    parent: { campaign: `customers/${customerId}/campaigns/${target.campaignId}` },
    resourceName: z.string().max(256).regex(new RegExp(`^customers/${customerId}/campaignCriteria/${target.campaignId}~[0-9]+$`)),
  };
}

/** Internal precheck only; ambiguous/malformed matches fail before any mutation.
 * One search, <=2 rows; text was normalized and restricted before GAQL interpolation.
 */
async function findNegative(required: NegativeCall & { input: NegativeInput; criterion: ReturnType<typeof criterionScope> }): Promise<Outcome<string | null>> {
  const { criterion, input } = required;
  const source = criterion.source;
  const rows = await searchRows({ ...required, query: `SELECT ${source}.resource_name, ${source}.negative, ${source}.type, ${source}.keyword.text, ${source}.keyword.match_type FROM ${source} WHERE ${criterion.filter} AND ${source}.negative = TRUE AND ${source}.type = KEYWORD AND ${source}.keyword.match_type = EXACT AND ${source}.keyword.text = '${input.text}' LIMIT 2` });
  if (!rows.ok) return rows;
  const schema = z.array(z.object({ [criterion.field]: z.object({
    resourceName: criterion.resourceName, negative: z.literal(true), type: z.literal("KEYWORD"),
    keyword: z.object({ text: keywordText.pipe(z.literal(input.text)), matchType: z.literal("EXACT") }),
  }) })).max(1);
  const parsed = parseBoundary({ schema, input: rows.value });
  if (!parsed.ok) return parsed;
  return success({ value: parsed.value[0]?.[criterion.field].resourceName ?? null });
}

/** Reuse the existing envelope decoder; incomplete evidence cannot permit a write. */
async function searchRows(required: Pick<NegativeCall, "transport" | "context" | "operationId"> & { query: string }): Promise<Outcome<Record<string, unknown>[]>> {
  const response = await required.transport.request({ method: "search", context: required.context, operationId: required.operationId, body: { query: required.query } });
  if (!response.ok) return response;
  const page = metricSearchRows({ value: response.value });
  if (!page.ok) return page;
  if (!page.value.complete) return failure({ code: "unavailable", message: "Incomplete Google negative-keyword evidence" });
  return success({ value: page.value.rows });
}

/** Exactly one scoped ACK establishes creation. Known Google rejections retain the
 * transport failure; adapter failures while receiving a response remain unknown.
 * O(1), no I/O. The existing adapter exposes these fixed sanitized failure messages.
 */
function mutationReceipt(required: { response: Outcome<unknown>; input: NegativeInput; criterion: ReturnType<typeof criterionScope> }): Outcome<NegativeReceipt> {
  const { response, input, criterion } = required;
  if (!response.ok) {
    if (["Google transport outcome is unknown", "Empty Google response", "Google response exceeds payload bound", "Invalid JSON or unavailable numeric precision"].includes(response.error.message)) return receipt({ input, status: "unknown" });
    return response;
  }
  const resultField = criterion.field + "Result";
  const ack = z.strictObject({ mutateOperationResponses: z.array(z.strictObject({ [resultField]: z.object({ resourceName: criterion.resourceName }) })).length(1) }).safeParse(response.value);
  if (!ack.success) return receipt({ input, status: "unknown" });
  return receipt({ input, status: "created", resourceName: ack.data.mutateOperationResponses[0][resultField].resourceName });
}

/** All receipt branches share the same schema; no tainted vendor payload is returned. */
function receipt(required: { input: NegativeInput; status: NegativeReceipt["status"]; resourceName?: string }): Outcome<NegativeReceipt> {
  return parseBoundary({ schema: negativeKeywordReceiptSchema, input: { ...required.input, status: required.status,
    matchType: "EXACT", ...(required.resourceName === undefined ? {} : { resourceName: required.resourceName }),
  } });
}
