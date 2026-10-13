import { createRoot } from "react-dom/client";
import { createStudioApp } from "./index.js";
import { browserRuntime, browserRoutes } from "./composition/adapters/browser.js";
import { createHttpStudioApi } from "./shared/api/index.js";
import "./styles.css";

/** Explicit browser entry; all DOM/time/ID effects are injected at the host boundary. */
const element = document.getElementById("root");
if (element) {
  const runtime = browserRuntime({ host: window, now: () => Date.now(), nextId: () => crypto.randomUUID() });
  const configured = document.querySelector<HTMLMetaElement>('meta[name="om-server-url"]')?.content;
  const api = configured === undefined ? undefined : createHttpStudioApi({
    baseUrl: configured === '/' ? window.location.origin : configured, fetch: window.fetch.bind(window), runtime,
    observer: { observe: event => console.info(event) },
  });
  createStudioApp({ root: createRoot(element), browser: browserRoutes({ host: window }), runtime, api }).start();
}
