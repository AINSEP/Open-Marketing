import { z } from "zod";
import { callContextSchema, idSchema, parseBoundary } from "@open-marketing/contracts";
import type { IdPort, Outcome } from "@open-marketing/contracts";
import type { TrackedLinkPort } from "../ports.js";
import type { TrackedLink, TrackedLinkRequest } from "../types.js";
import { clone, failure, linkRequestSchema, nextId, scopeKey, storageLimit } from "../rules.js";

const utmKeys = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
/** HTTPS origin allowlist used both at create and redirect. Query keys need explicit
 * authorization; no network request, redirect following, identifier hashing or collection.
 * @example validateTrackedDestination({ url: "https://shop.example/signup", allowedOrigins: ["https://shop.example"] })
 * @complexity O(k) for at most 24 query entries and 4096 URL characters. */
export function validateTrackedDestination(required: { url: string; allowedOrigins: readonly string[]; allowedQueryKeys?: readonly string[] }): Outcome<string> {
  const parsed = parseBoundary({ schema: z.string().min(1).max(4096), input: required.url });
  if (!parsed.ok) return parsed;
  let url: URL;
  try { url = new URL(parsed.value); }
  catch { return failure({ code: "invalid_input", message: "Invalid destination URL" }); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return failure({ code: "forbidden", message: "Unsafe destination URL" });
  if (!required.allowedOrigins.includes(url.origin)) return failure({ code: "forbidden", message: "Destination origin is not allowed" });
  const entries = [...url.searchParams];
  if (entries.length > 24) return failure({ code: "limit_exceeded", message: "Too many destination query parameters" });
  if (new Set(entries.map(([key]) => key)).size !== entries.length) return failure({ code: "invalid_input", message: "Ambiguous duplicate query parameters" });
  const allowed = new Set([...utmKeys, ...(required.allowedQueryKeys ?? [])]);
  if (entries.some(([key]) => !allowed.has(key))) return failure({ code: "forbidden", message: "Destination query identifier is not authorized" });
  return { ok: true, value: url.href };
}

/** Memory redirect adapter. Inject origin policy and IDs; an empty configuration denies.
 * Exact query keys such as click IDs require explicit admission by the server.
 * @example createMemoryTrackedLink({ allowedOrigins: ["https://shop.example"], baseUrl: "https://om.example/l/", ids })
 * @complexity O(1) map operations plus bounded URL validation. Storage caps at maxRecords. */
export function createMemoryTrackedLink(required: { allowedOrigins?: readonly string[]; allowedQueryKeys?: readonly string[]; baseUrl?: string; ids?: IdPort; maxRecords?: number }): TrackedLinkPort {
  const limit = storageLimit(required);
  const records = new Map<string, TrackedLink>();
  let sequence = 0;
  const policy = { allowedOrigins: [...(required.allowedOrigins ?? [])], allowedQueryKeys: [...(required.allowedQueryKeys ?? [])] };
  return {
    async create(input) {
      const context = parseBoundary({ schema: callContextSchema, input: input.context });
      if (!context.ok) return context;
      const request = parseBoundary({ schema: linkRequestSchema, input: input.request });
      if (!request.ok) return request;
      if (records.size >= limit) return failure({ code: "limit_exceeded", message: "Tracked link storage limit" });
      const id = nextId({ ids: required.ids, fallback: "link-" + ++sequence });
      if (!id.ok) return id;
      const linkId = id.value;
      const link = prepareTrackedLink({ linkId, request: request.value, baseUrl: required.baseUrl, ...policy });
      if (!link.ok) return link;
      const key = JSON.stringify([scopeKey({ scope: context.value.scope }), linkId]);
      if (records.has(key)) return failure({ code: "conflict", message: "Tracked link ID collision" });
      records.set(key, clone({ value: link.value }));
      return link;
    },
    async resolve(input) {
      const context = parseBoundary({ schema: callContextSchema, input: input.context });
      if (!context.ok) return context;
      const id = parseBoundary({ schema: idSchema, input: input.linkId });
      if (!id.ok) return id;
      const key = JSON.stringify([scopeKey({ scope: input.context.scope }), input.linkId]);
      const link = records.get(key);
      if (!link) return failure({ code: "unavailable", message: "Tracked link not found" });
      const validated = validateTrackedDestination({ url: link.destinationUrl, ...policy });
      if (!validated.ok) return validated;
      return { ok: true, value: clone({ value: link }) };
    },
  };
}
function makeLink(required: { linkId: string; destinationUrl: string; campaignId: string; baseUrl?: string }): Outcome<TrackedLink> {
  if (!required.baseUrl) return failure({ code: "unavailable", message: "Tracked link base URL is required" });
  try {
    const base = new URL(required.baseUrl);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) return failure({ code: "invalid_input", message: "Unsafe tracked link base URL" });
    const url = new URL(encodeURIComponent(required.linkId), base.href.endsWith("/") ? base : base.href + "/");
    return { ok: true, value: { linkId: required.linkId, url: url.href, destinationUrl: required.destinationUrl, campaignId: required.campaignId } };
  } catch { return failure({ code: "invalid_input", message: "Invalid tracked link base URL" }); }
}

/** Pure link creation shared by memory and SQL; unknown query keys fail before UTM merge. */
export function prepareTrackedLink(required: { linkId: string; request: TrackedLinkRequest; baseUrl?: string; allowedOrigins: readonly string[]; allowedQueryKeys?: readonly string[] }): Outcome<TrackedLink> {
  const id = parseBoundary({ schema: idSchema, input: required.linkId });
  if (!id.ok) return id;
  if (id.value === "." || id.value === "..") return failure({ code: "invalid_input", message: "Tracked link ID is a dot path segment" });
  const request = parseBoundary({ schema: linkRequestSchema, input: required.request });
  if (!request.ok) return request;
  const initial = validateTrackedDestination({ url: request.value.destinationUrl, allowedOrigins: required.allowedOrigins, allowedQueryKeys: required.allowedQueryKeys });
  if (!initial.ok) return initial;
  const destination = new URL(initial.value);
  Object.entries(request.value.utm).forEach(([key, value]) => destination.searchParams.set(key, value));
  const final = validateTrackedDestination({ url: destination.href, allowedOrigins: required.allowedOrigins, allowedQueryKeys: required.allowedQueryKeys });
  if (!final.ok) return final;
  return makeLink({ linkId: required.linkId, destinationUrl: final.value, campaignId: request.value.campaignId, baseUrl: required.baseUrl });
}
