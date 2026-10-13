/** Shared B1 behavior suites: every implementation runs these same assertions. */
export { CreativeRepoPortSuite } from "./repo-suite.js";
export { GenerationCapabilityPortSuite } from "./capability-suite.js";
export type { CapabilityFixture } from "./capability-suite.js";
export { CreativeAssetPortSuite, CreativeJobPortSuite, CreativeSpendPortSuite, CreativeAuditPortSuite, CreativeObserverPortSuite } from "./effect-suites.js";
