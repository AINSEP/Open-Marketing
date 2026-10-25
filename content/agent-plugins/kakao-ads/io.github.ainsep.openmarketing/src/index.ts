/** Sole public API; imports and factory construction perform no I/O. */
export { createKakaoAdsAdapter } from "./transport.js";
export { commandSchema, kakaoAdsTools } from "./commands.js";
export type { KakaoCommand } from "./commands.js";
export type { KakaoConfiguration, KakaoCredentialPort, KakaoEntity, KakaoAccountsPage, KakaoCampaignList, KakaoResult, KakaoInvocation, KakaoAdsAdapter, KakaoDependencies } from "./ports.js";
export type { KakaoReport } from "./reporting.js";
