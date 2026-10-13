import type { Outcome } from "@open-marketing/contracts";
import { clickKeys, failure } from "./rules.js";

/** Inert script expression: host invokes it with { now, nextId, location, fetch }.
 * POST carries observed event metadata and allowlisted query values only. Server ingress
 * authenticates the visit, verifies link/campaign, and supplies scope, trace, receipt/cursor.
 * No token issuance, cookies, listeners, retries or storage are embedded here.
 * @example webEventSnippetSource({ collectionPath: "/c" })
 * @complexity O(q), query string capped at 16 KiB; six bounded properties, one fetch.
 */
export function webEventSnippetSource(required: { collectionPath: string }): Outcome<string> {
  if (typeof required.collectionPath !== "string" || required.collectionPath.length > 256 || required.collectionPath.trim() !== required.collectionPath || !/^\/(?!\/)[A-Za-z0-9/_-]+$/.test(required.collectionPath)) return failure({ code: "invalid_input" });
  const path = JSON.stringify(required.collectionPath);
  const keys = JSON.stringify(["linkId", "campaignId", ...clickKeys]);
  return { ok: true, value: `(async function({ now, nextId, location, fetch }) {
  if (typeof location.search !== "string" || location.search.length > 16384) return;
  const params = new URLSearchParams(location.search);
  const properties = {};
  function validProperty({ key, value }) {
    const isId = key === "linkId" || key === "campaignId";
    const limit = isId ? 256 : 2048;
    const pattern = isId ? /^[A-Za-z0-9][A-Za-z0-9._:-]*$/ : /^[A-Za-z0-9._-]+$/;
    return value.length <= limit && value.trim() === value && pattern.test(value);
  }
  for (const key of ${keys}) {
    const value = params.get(key);
    if (value === null) continue;
    if (!validProperty({ key, value })) return;
    properties[key] = value;
  }
  const occurredAt = now({});
  const eventId = nextId({});
  if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) return;
  if (typeof eventId !== "string" || eventId.trim() !== eventId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(eventId)) return;
  const body = JSON.stringify({ eventId, schema: "om.web.landing", version: 1, source: "first-party", name: "landing", properties, occurredAt });
  return fetch(${path}, { method: "POST", mode: "same-origin", credentials: "same-origin", referrerPolicy: "no-referrer", headers: { "Content-Type": "application/json" }, body });
})` };
}
