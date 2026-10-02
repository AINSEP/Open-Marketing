import { createRoot } from "react-dom/client";
import { createStudioApp } from "./index.js";
import "./styles.css";
/** Explicit browser entry invokes the sole composition root. */
const element = document.getElementById("root");
if (element) createStudioApp({ root: createRoot(element) }).start();
