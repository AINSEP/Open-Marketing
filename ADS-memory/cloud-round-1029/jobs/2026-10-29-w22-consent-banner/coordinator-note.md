# COORDINATOR NOTE for the trim (f6, 10-29; arrived after the plan started — wins over plan.md)
tovu-a5: @jini-ai/cookie-consent is PUBLISHED in 0.6.15-rc.2 (exports . ./policy ./plugins ./render ./client ./client.min.js ./banner.css ./server ./node; README has a standalone example). Not yet installed in OM → Coordinator NEEDS: add dep (frozen-lockfile hand edit) to the package(s) that import it, before the build.
REUSE it; OM builds ONLY the OM-specific wiring:
1. Render the banner (renderBanner() from /render; mode 'jini' built-in, 'headless' if the site has its own CMP driving window.jiniConsent, 'off') on OM visitor pages; serve dist/client.min.js (+ banner.css).
2. Mount handleReceipt (/server, Request→Response) with a store (createConsentFileRecords/createNodeConsentFiles from /node, or an OM store port over the existing consent evidence path); choose evidence mode ('durable' = grant applies only after receipt stored — prefer, matches consent-first).
3. Wrap OM's own analytics/marketing collectors (snippet touch/cookie, vendor tags) as consent adapters (categories functional/analytics/marketing) with a REAL revoke() (clears OM cookie, stops collection).
4. Footer reopen link (.jini-consent-reopen / jiniConsent.open()) = withdrawal; withdrawal must also be recorded so later conversion dispatch is refused.
5. Server decides the consent level from the stored receipt; never trust the browser payload's level (today public.ts accepts consent: z.literal(true) from the page — reconcile with the receipt).
6. Hosted form /f/:slug (NOT in the package — OM's): read the same jiniConsent state for the marketing category (no second consent state) and store the opt-in with the submission.
GPC/DNT force analytics+marketing off (package behaviour — keep it). Cut any OM-built banner, CMP state or withdrawal mechanism the package already provides.
