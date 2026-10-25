import { z } from "zod";
import type { AppError, Outcome } from "@open-marketing/contracts";
import { encodeReport, reportCommandSchema } from "./reporting.js";

/** Decimal IDs remain strings; JSON long values must fit exactly before wire conversion. */
export const vendorId = z.string().regex(/^[1-9][0-9]{0,15}$/).refine(value => Number.isSafeInteger(Number(value)));
export const providerId = z.union([vendorId, z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String)]);
export const loginSchema = z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/);
const ids = z.array(vendorId).min(1).max(100).refine(value => new Set(value).size === value.length);
const page = { limit: z.number().int().min(1).max(100).default(100), offset: z.number().int().min(0).max(1000000).default(0) };
/** Closed reads only. Connected identity has no vendor paging; extra fields reject. */
export const yandexDirectCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("list_accounts"), view: z.enum(["connected", "agency"]), ...page }).refine(value => value.view !== "connected" || value.offset === 0),
  z.strictObject({ kind: z.literal("list_campaigns"), ids: ids.optional(), ...page }),
  reportCommandSchema,
]);
/** Caller input may omit bounded page defaults. */
export type YandexDirectCommand = z.input<typeof yandexDirectCommandSchema>;
export type ParsedCommand = z.infer<typeof yandexDirectCommandSchema>;
/** Fixed request bytes; headers exclude credentials and cannot be supplied by tool callers. */
export interface YandexDirectRequest { readonly url: string; readonly method: "POST"; readonly body: string; readonly headers: Readonly<Record<string, string>> }
/** Inert tool descriptors consumed by the server catalog; no registration at import. */
export const yandexDirectTools = yandexDirectCommandSchema.options.map(inputSchema => ({ name: inputSchema.shape.kind.value, inputSchema, effect: "read" as const }));

/** Map validated commands to documented v501 services; no arbitrary method/path or I/O.
 * @complexity O(n) time/space, n<=100 IDs. */
export function encodeCommand(required: { command: ParsedCommand; clientLogin?: string }): YandexDirectRequest {
  const { command } = required;
  const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8", "Accept-Language": "en" };
  if (command.kind !== "list_accounts" && required.clientLogin) headers["Client-Login"] = required.clientLogin;
  const Page = { Limit: command.limit, Offset: command.offset };
  switch (command.kind) {
    case "list_accounts": {
      const params = { FieldNames: ["ClientId", "Login", "Currency", "Type"], ...(command.view === "agency" ? { SelectionCriteria: {}, Page } : {}) };
      return request({ service: command.view === "agency" ? "agencyclients" : "clients", body: { method: "get", params }, headers });
    }
    case "list_campaigns": return request({ service: "campaigns", body: { method: "get", params: { SelectionCriteria: command.ids ? { Ids: command.ids.map(Number) } : {}, FieldNames: ["Id", "Name", "Type", "State", "Status"], Page } }, headers });
    case "report": return request({ service: "reports", body: encodeReport({ command }), headers: { ...headers, processingMode: "online", skipReportHeader: "true", skipReportSummary: "true" } });
    default: { const exhaustive: never = command; return exhaustive; }
  }
}
function request(required: { service: string; body: object; headers: Record<string, string> }): YandexDirectRequest { return { url: "https://api.direct.yandex.com/json/v501/" + required.service, method: "POST", body: JSON.stringify(required.body), headers: Object.freeze(required.headers) }; }
/** Typed redacted errors never include vendor text, response bodies or tokens. */
export function failure(required: { code: AppError["code"] }): Outcome<never> { return { ok: false, error: { code: required.code, message: "Yandex Direct request " + required.code, retryable: false } }; }
const account = z.object({ ClientId: providerId, Login: loginSchema, Currency: z.string().regex(/^[A-Z]{3}$/).optional(), Type: z.enum(["CLIENT", "AGENCY", "SUBCLIENT"]) });
const campaign = z.object({ Id: providerId, Name: z.string().max(255), Type: z.enum(["TEXT_CAMPAIGN", "MOBILE_APP_CAMPAIGN", "CPM_BANNER_CAMPAIGN", "UNIFIED_CAMPAIGN", "UNKNOWN"]), State: z.enum(["CONVERTED", "ARCHIVED", "SUSPENDED", "ENDED", "ON", "OFF", "UNKNOWN"]), Status: z.enum(["DRAFT", "MODERATION", "ACCEPTED", "REJECTED", "UNKNOWN"]) });
/** Atomic entity projection; duplicate or unrequested IDs and invalid continuations reject.
 * Unknown provider fields are stripped. Discovery is candidate data, never an access grant.
 * @complexity O(n*m) time, O(n) space; n,m<=100, no I/O. */
export function decodeList(required: { input: unknown; command: Exclude<ParsedCommand, { kind: "report" }>; accountId?: string }): Outcome<unknown> {
  const { command } = required;
  const parsed = z.object({ result: z.object({ Clients: z.array(account).max(command.limit).optional(), Campaigns: z.array(campaign).max(command.limit).optional(), LimitedBy: z.number().int().min(1).max(1000000).optional() }) }).safeParse(required.input);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const items = command.kind === "list_campaigns" ? parsed.data.result.Campaigns : parsed.data.result.Clients;
  if (!items) return failure({ code: "protocol_mismatch" });
  const checked = checkList({ ...required, items });
  if (!checked.ok) return checked;
  const pagination = pageInfo({ command, count: items.length, limitedBy: parsed.data.result.LimitedBy });
  return pagination.ok ? { ok: true, value: { items, accountId: required.accountId ?? null, ...pagination.value } } : pagination;
}
/** Connected identity has no pagination. Full pages conservatively expose another explicit read.
 * @complexity O(1), no effects; rejects non-progressing or empty vendor continuations. */
function pageInfo(required: { command: Exclude<ParsedCommand, { kind: "report" }>; count: number; limitedBy?: number }): Outcome<{ potentiallyIncomplete: boolean; nextOffset: number | null }> {
  const { command, limitedBy, count } = required;
  if (limitedBy !== undefined && (limitedBy <= command.offset || count === 0)) return failure({ code: "protocol_mismatch" });
  if (command.kind === "list_accounts" && command.view === "connected") return { ok: true, value: { potentiallyIncomplete: false, nextOffset: null } };
  const next = limitedBy ?? (count === command.limit ? command.offset + count : null);
  return { ok: true, value: { potentiallyIncomplete: next !== null, nextOffset: next !== null && next <= 1000000 ? next : null } };
}
/** Reject a whole page if one identifier violates the selected account/filter or repeats.
 * @complexity O(n*m), n,m<=100; no effects. */
function checkList(required: { items: Record<string, unknown>[]; command: Exclude<ParsedCommand, { kind: "report" }>; accountId?: string }): Outcome<void> {
  const { items, command } = required;
  const keys = items.map(value => String(value.Id ?? value.ClientId));
  if (new Set(keys).size !== keys.length) return failure({ code: "protocol_mismatch" });
  if (command.kind === "list_campaigns" && command.ids && keys.some(id => !command.ids!.includes(id))) return failure({ code: "protocol_mismatch" });
  if (command.kind === "list_accounts" && command.view === "connected" && required.accountId && keys.some(id => id !== required.accountId)) return failure({ code: "forbidden" });
  return { ok: true, value: undefined };
}
