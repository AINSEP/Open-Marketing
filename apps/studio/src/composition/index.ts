import { createElement } from "react";
import type { Root } from "react-dom/client";
import { Shell } from "../app/Shell.js";
/** Sole studio composition root. Browser mounting is explicit; importing or constructing never touches DOM. */
export function createStudioApp(required: { root: Root }) { return { start: () => required.root.render(createElement(Shell)), stop: () => required.root.unmount() }; }
