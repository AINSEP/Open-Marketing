import { OMChatPane } from "../widgets/om-chat/index.js";
import type { NavigationTarget } from "@open-marketing/contracts";
const navigation: readonly NavigationTarget[] = ["workspaces", "creative", "media-library", "campaigns", "measure", "connections", "plugins", "activity", "settings"];
const links = navigation.map(target => <a key={target} href={"#" + target}>{target}</a>);
/** Approved left-navigation / canvas / right-chat skeleton; no domain capability is represented as complete. */
export function Shell() { return <div className="shell"><nav aria-label="Features"><h1>Open Marketing</h1>{links}</nav><main><h2>Workspace canvas</h2><p>Select a feature. Feature implementation is pending.</p></main><OMChatPane /></div>; }
