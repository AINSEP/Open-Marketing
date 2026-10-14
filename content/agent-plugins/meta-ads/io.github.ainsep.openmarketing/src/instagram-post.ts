import { isIP } from "node:net";
import { z } from "zod";
import type { CallOptions, Outcome } from "@open-marketing/contracts";
import { vendorIdSchema } from "./commands.js";

export const localMediaMessage = "Instagram needs a publicly reachable media URL; this OM asset is only available locally.";

/** Reject local hostnames/IP literals without DNS lookup or fetching media. @complexity O(n) URL parsing, <=2KiB. */
function publicMediaUrl(required: { value: string }): boolean {
  let url: URL;
  try { url = new URL(required.value); } catch { return false; }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (url.protocol !== "https:") return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false;
  if (isIP(host) === 4) return !privateIpv4({ host });
  if (isIP(host) === 6) return !privateIpv6({ host });
  return true;
}

/** Includes loopback, private, link-local, shared and unspecified literal ranges. @complexity O(1). */
function privateIpv4(required: { host: string }): boolean {
  const [first, second] = required.host.split(".").map(Number);
  const ranges = [[169, 254, 254], [172, 16, 31], [192, 168, 168], [100, 64, 127], [198, 18, 19]] as const;
  return [0, 10, 127].includes(first) || ranges.some(([network, min, max]) => first === network && second >= min && second <= max);
}

/** URL normalizes mapped IPv4 to hexadecimal; inspect that address as well. @complexity O(1). */
function privateIpv6(required: { host: string }): boolean {
  const host = required.host;
  if (host.startsWith("::ffff:")) {
    const parts = host.slice(7).split(":").map(part => Number.parseInt(part, 16));
    const mapped = `${parts[0] >>> 8}.${parts[0] & 255}.${parts[1] >>> 8}.${parts[1] & 255}`;
    return privateIpv4({ host: mapped });
  }
  return host === "::" || host === "::1" || /^(fc|fd|fe[89ab]|fec)/.test(host);
}

const mediaUrlSchema = z.string().max(2048).refine(value => publicMediaUrl({ value }), { message: localMediaMessage });
const captionSchema = z.string().max(4400).refine(value => Array.from(value).length <= 2200)
  .refine(value => (value.match(/#[\p{L}\p{N}_]+/gu) ?? []).length <= 30)
  .refine(value => (value.match(/@[\p{L}\p{N}_.]+/gu) ?? []).length <= 20);
const postBase = { igUserId: vendorIdSchema, caption: captionSchema };
/** Closed inputs reject scheduling and incompatible media fields rather than publishing immediately. */
export const metaInstagramPostSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("image"), ...postBase, imageUrl: mediaUrlSchema }),
  z.strictObject({ kind: z.literal("carousel"), ...postBase, items: z.array(z.union([z.strictObject({ imageUrl: mediaUrlSchema }), z.strictObject({ videoUrl: mediaUrlSchema })])).min(2).max(10) }),
  z.strictObject({ kind: z.literal("reel"), ...postBase, videoUrl: mediaUrlSchema }),
  z.strictObject({ kind: z.literal("resume"), ...postBase, containerId: vendorIdSchema }),
]);
export type MetaInstagramPost = z.infer<typeof metaInstagramPostSchema>;
export type MetaInstagramPublishResult = { status: "published"; mediaId?: string } | { status: "processing"; containerId: string } | { status: "unknown"; containerId?: string };
export type MetaInstagramWait = (required: { milliseconds: number }, optional?: CallOptions) => Promise<Outcome<void>>;
/** Internal callback keeps orchestration independent of the server adapter; all I/O still uses dispatch. */
export type InstagramGraphCall = (required: { method: "GET" | "POST"; path: string; parameters: Readonly<Record<string, string | boolean>> }) => Promise<Outcome<unknown>>;
