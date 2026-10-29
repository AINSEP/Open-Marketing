import { createRoot } from "react-dom/client";
import { REMIXICON_STYLESHEET_MARKER } from "@jini-ai/ui";
import remixiconCss from "@jini-ai/ui/remixicon.css?inline";
import { createStudioApp } from "./index.js";
import { browserFrontendRequest, browserRuntime, browserRoutes, browserStorage } from "./composition/adapters/browser.js";
import { createBrowserChartHost } from './features/chart-providers/index.js';
import { createHttpStudioApi } from "./shared/api/index.js";
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/dm-sans";
import "./styles.css";

// Process font URLs through Vite and mark the override before any Jini icon mounts.
const remixiconStyle = document.createElement("style");
remixiconStyle.setAttribute(REMIXICON_STYLESHEET_MARKER, "");
remixiconStyle.textContent = remixiconCss;
document.head.appendChild(remixiconStyle);

/** Explicit browser entry; all DOM/time/ID effects are injected at the host boundary. */
const element = document.getElementById("root");
if (element) {
  const runtime = browserRuntime({ host: window, now: () => Date.now(), nextId: () => crypto.randomUUID() });
  const configured = document.querySelector<HTMLMetaElement>('meta[name="om-server-url"]')?.content;
  const browserFetch = window.fetch.bind(window);
  const observer = { observe: (event: Parameters<import('@open-marketing/contracts').ObserverPort['observe']>[0]) => console.info(event) };
  const api = configured === undefined ? undefined : createHttpStudioApi({
    baseUrl: configured === '/' ? window.location.origin : configured, fetch: browserFetch, runtime, observer,
  });
  createStudioApp({ root: createRoot(element), browser: browserRoutes({ host: window }), runtime, api,
    charts: api ? createBrowserChartHost({ document, fetch: browserFetch, runtime, observer,
      importModule: ({ url }) => import(/* @vite-ignore */ url) }) : undefined,
    frontend: api ? { root: element, transport: { baseUrl: '', openStream: ({ url }) => new EventSource(url),
      request: browserFrontendRequest({ fetch: browserFetch, runtime, observer }) },
      navigate: ({ page }) => { window.location.hash = page; }, reducedMotion: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      scroll: ({ element: target, options }) => target.scrollIntoView(options) } : undefined,
    doc: document,
    appearance: { root: document.documentElement, storage: browserStorage({ host: window }), matchMedia: window.matchMedia.bind(window) },
  }).start();
}
