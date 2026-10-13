import { createRoot } from "react-dom/client";
import { createStudioApp } from "./index.js";
import { browserRuntime, browserRoutes } from "./composition/adapters/browser.js";
import "./styles.css";

/** Explicit browser entry; all DOM/time/ID effects are injected at the host boundary. */
const element = document.getElementById("root");
if (element) createStudioApp({ root: createRoot(element), browser: browserRoutes({ host: window }), runtime: browserRuntime({ host: window, now: () => Date.now(), nextId: () => crypto.randomUUID() }) }).start();
