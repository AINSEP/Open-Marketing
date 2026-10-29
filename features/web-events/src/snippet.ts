import { trackingTagOutputSchema } from "@open-marketing/contracts";
import type { Outcome, TrackingTagOutput } from "@open-marketing/contracts";
import { z } from "zod";
import { clickKeys, failure } from "./rules.js";

/** Inert expression invoked with { now, nextId, location, fetch, document, consent, signal?, activated? }.
 * Host supplies admitted plugin tags and visitor consent (true or a promise resolving true).
 * Captured landing data stays in page memory; POST and tags wait for literal true consent.
 * An aborted signal (consent withdrawn) is checked once before the POST and before each tag;
 * activated() is called before each tag runs, since tags cannot be unloaded.
 * POST contains bounded claims and a query/fragment-free page URL. Ingress authenticates
 * visit, origin and scope. No vendor bootstrap, cookies, listeners or retry queue lives here.
 * @example webEventSnippetSource({ collectionPath: "/c", tags })
 * @complexity O(q+s), query <=16 KiB, <=2 tag snippets of <=32 KiB; one collection fetch.
 */
export function webEventSnippetSource(required: { collectionPath: string; tags?: readonly TrackingTagOutput[] }): Outcome<string> {
  if (typeof required.collectionPath !== "string" || required.collectionPath.length > 256 || required.collectionPath.trim() !== required.collectionPath || !/^\/(?!\/)[A-Za-z0-9/_-]+$/.test(required.collectionPath)) return failure({ code: "invalid_input" });
  const parsed = z.array(trackingTagOutputSchema).max(2).safeParse(required.tags ?? []);
  if (!parsed.success) return failure({ code: "invalid_input" });
  // Safe to embed inside a host script element even if plugin text contains </script>.
  const tags = JSON.stringify(parsed.data.map(tag => tag.snippet)).replace(/</g, "\\u003c");
  const keys = JSON.stringify(["linkId", ...clickKeys]);
  return { ok: true, value: `(async function({ now, nextId, location, fetch, document, consent, signal, activated }) {
  if (typeof location.search !== "string" || location.search.length > 16384) return;
  const params = new URLSearchParams(location.search);
  const properties = {};
  function validProperty({ key, value }) {
    const isId = key === "linkId";
    const limit = isId ? 256 : 2048;
    const pattern = isId ? /^[A-Za-z0-9][A-Za-z0-9._:-]*$/ : /^[A-Za-z0-9._-]+$/;
    return value.length <= limit && value.trim() === value && pattern.test(value);
  }
  function captureClicks() {
    for (const key of ${keys}) {
      const values = params.getAll(key);
      if (values.length === 0) continue;
      if (values.length !== 1 || !validProperty({ key, value: values[0] })) return false;
      properties[key] = values[0];
    }
    return true;
  }
  if (!captureClicks()) return;
  const claimKeys = ["campaignId", "utm_source", "utm_medium", "om_a", "utm_id"];
  function singleClaim({ key }) { return params.getAll(key).length <= 1 && (params.get(key) || "").length <= 256; }
  function captureClaims() {
    if (!claimKeys.every(key => singleClaim({ key }))) return;
    for (const key of claimKeys) {
      const value = params.get(key);
      if (value !== null) properties[key] = value;
    }
  }
  captureClaims();
  function capturePage() {
    if (typeof location.href !== "string") return true;
    if (location.href.length > 16384) return false;
    if (!URL.canParse(location.href)) return false;
    const page = new URL(location.href);
    if (page.protocol === "http:") return true;
    if (page.protocol !== "https:" || page.username || page.password) return false;
    const pageUrl = page.origin + page.pathname;
    if (pageUrl.length > 2048) return false;
    properties.pageUrl = pageUrl;
    return true;
  }
  if (!capturePage()) return;
  const occurredAt = now({});
  const eventId = nextId({});
  if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) return;
  if (typeof eventId !== "string" || eventId.trim() !== eventId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(eventId)) return;
  const body = JSON.stringify({ eventId, schema: "om.web.landing", version: 1, source: "first-party", name: "landing", properties, occurredAt, consent: true });
  async function activate({ snippet }) {
    const template = document.createElement("template");
    template.innerHTML = snippet;
    for (const source of template.content.querySelectorAll("script")) {
      const script = document.createElement("script");
      for (const attribute of source.attributes) script.setAttribute(attribute.name, attribute.value);
      script.async = false;
      script.textContent = source.textContent;
      const loaded = script.src ? new Promise((resolve, reject) => { script.onload = resolve; script.onerror = reject; }) : Promise.resolve();
      document.head.appendChild(script);
      await loaded;
    }
  }
  async function activateTags() {
    for (const snippet of ${tags}) {
      if (signal && signal.aborted) return;
      if (activated) activated();
      await activate({ snippet });
    }
  }
  if (await consent !== true) return;
  if (signal && signal.aborted) return;
  const collection = fetch(${JSON.stringify(required.collectionPath)}, { method: "POST", mode: "same-origin", credentials: "same-origin", referrerPolicy: "no-referrer", headers: { "Content-Type": "application/json" }, body });
  void activateTags().catch(() => {});
  return collection;
})` };
}

/** Browser installer: registers ONE @jini-ai/cookie-consent adapter (category marketing, because the
 * collector stores ad click IDs) on window.jiniConsentQueue. Collection and tags wait for Jini's durable
 * marketing grant; captured landing data stays in page memory until then.
 * Sites with their own CMP (banner mode headless) call window.omGrantConsent(), a bridge to
 * window.jiniConsent.set({ action: "accept" }); a call made before the Jini client loads is queued once and
 * replayed on its jini:consent-ready event.
 * Withdrawal: window.jiniConsent.open() or a footer link with class "jini-consent-reopen" reopens the
 * choice; withdrawing calls revoke(), which stops further collection and sends DELETE <collectionPath>
 * so the server clears OM's visit cookie. revoke() returns false once a tag ran (Jini then reloads).
 * Returns invalid_input for an unsafe path or tags; never executes on the server.
 * @example webEventInstallSource({ collectionPath: "/c", tags })
 * @complexity O(source bytes), bounded by the expression generator's two-tag limit.
 */
export function webEventInstallSource(required: { collectionPath: string; tags?: readonly TrackingTagOutput[] }): Outcome<string> {
  const source = webEventSnippetSource(required);
  if (!source.ok) return source;
  const path = JSON.stringify(required.collectionPath);
  return { ok: true, value: `(() => {
  let grant;
  let tagRan = false;
  const stop = new AbortController();
  const consent = new Promise(resolve => { grant = resolve; });
  (window.jiniConsentQueue = window.jiniConsentQueue || []).push({ id: "om-web-events", kind: "consent-adapter", category: "marketing",
    grant({ signal }) {
      if (signal.aborted || stop.signal.aborted) return null;
      if (grant) { grant(true); grant = undefined; }
      return { revoke() {
        stop.abort();
        window.fetch(${path}, { method: "DELETE", mode: "same-origin", credentials: "same-origin" }).catch(() => {});
        return !tagRan;
      } };
    } });
  let queuedGrant = false;
  window.omGrantConsent = () => {
    if (window.jiniConsent) return window.jiniConsent.set({ action: "accept" });
    if (queuedGrant) return undefined;
    queuedGrant = true;
    window.document.addEventListener("jini:consent-ready", event => {
      const api = window.jiniConsent || (event && event.detail);
      if (api) api.set({ action: "accept" });
    }, { once: true });
    return undefined;
  };
  return ${source.value}({ now: () => Date.now(), nextId: () => crypto.randomUUID(), location: window.location,
    fetch: window.fetch.bind(window), document: window.document, consent, signal: stop.signal, activated: () => { tagRan = true; } }).catch(() => {});
})();` };
}
