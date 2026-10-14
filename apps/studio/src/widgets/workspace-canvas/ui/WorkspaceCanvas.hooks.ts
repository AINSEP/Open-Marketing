import type { ConfirmationCard, Money, NavigationTarget } from "@open-marketing/contracts";
import type { StudioApiPort, StudioSnapshot, StudioRuntime, StudioMetric, StudioRow } from "../../../shared/api/index.js";
import type { ApprovalCardProps } from "../../../features/approve/index.js";

/** The shell supplies the same API/runtime used by chat; pages never construct adapters. */
export interface WorkspaceCanvasProps {
  readonly target: NavigationTarget; readonly snapshot: StudioSnapshot;
  readonly onOpenChat: () => void; readonly api: StudioApiPort; readonly runtime: StudioRuntime;
}
type Pages = NonNullable<StudioSnapshot["pages"]>;
type Generation = Pages["creative"]["generations"][number];
type Asset = Pages["creative"]["assets"][number];
type Draft = Pages["campaigns"]["drafts"][number];
type Allowance = Pages["campaigns"]["allowances"][number];
type Report = Pages["operations"]["reports"][number];
export type GenerationView = Generation & { readonly quoteText: string; readonly estimatedText: string; readonly actualText: string; readonly classificationText: string; readonly approval: ApprovalCardProps | null };
export type AssetView = Asset & { readonly costText: string; readonly originalTitle: string };
export type DraftView = Draft & { readonly approval: ApprovalCardProps | null };
export type AllowanceView = Allowance & { readonly dailyText: string; readonly usedText: string; readonly reservedText: string; readonly remainingText: string };
export type ReportView = Report & { readonly sourceText: string; readonly cacText: string; readonly restatementText: string };
/** Display models retain API evidence verbatim alongside formatted money and card associations. */
export interface CreativeMediaModel { readonly generations: readonly GenerationView[]; readonly assets: readonly AssetView[] }
export interface CampaignSafetyModel { readonly drafts: readonly DraftView[]; readonly halts: Pages["campaigns"]["halts"]; readonly allowances: readonly AllowanceView[] }
export interface OperationsModel extends Omit<Pages["operations"], "reports"> { readonly reports: readonly ReportView[] }
/** Page copy and destinations for the three first-use canvas states. */
export interface CanvasEmptyStateModel { readonly message: string; readonly linkLabel: string; readonly href: string; readonly assistantLabel: string }
export interface WorkspaceCanvasModel {
  readonly rows: readonly StudioRow[]; readonly metrics: readonly StudioMetric[]; readonly heading: string;
  readonly creative: CreativeMediaModel | null; readonly campaigns: CampaignSafetyModel | null; readonly operations: OperationsModel | null;
  readonly emptyState: CanvasEmptyStateModel | null;
}
const emptyStates = {
  campaigns: { message: "Your campaigns and draft reviews will appear here.", linkLabel: "Connect an ad account in Integrations", href: "#/addons/integrations", assistantLabel: "Ask the assistant to draft one" },
  "media-library": { message: "Your images, videos, and creative assets will appear here.", linkLabel: "Connect an account in Integrations", href: "#/addons/integrations", assistantLabel: "Ask the assistant to create an image" },
  activity: { message: "Your jobs, approvals, and outcomes will appear here.", linkLabel: "Connect an account in Integrations", href: "#/addons/integrations", assistantLabel: "Ask the assistant to help you get started" },
} satisfies Record<string, CanvasEmptyStateModel>;
const allowanceLabels: Record<Generation["allowanceClassification"], string> = {
  within_allowance: "Within daily allowance · server assessment",
  over_allowance: "Over daily allowance · exact approval required",
  unknown_cost: "Unknown cost · exact approval required",
};
const sourceLabels: Record<Report["source"], string> = { om_ledger: "OM ledger", platform_report: "Platform report", om_attribution: "OM attribution" };

/** Prepare display only: never infer eligibility, serving status or cost settlement.
 * @example useWorkspaceCanvas({ target, snapshot, onOpenChat, api, runtime })
 * @complexity O(n) time/space across bounded snapshot lists; no I/O or retained state.
 */
export function useWorkspaceCanvas(required: WorkspaceCanvasProps): WorkspaceCanvasModel {
  const pages = required.snapshot.pages;
  const cards = new Map(required.snapshot.cards.map(card => [card.cardId, card]));
  return {
    rows: required.snapshot.rows[required.target] ?? [], metrics: required.snapshot.metrics,
    heading: canvasHeading({ target: required.target }),
    emptyState: canvasEmptyState({ target: required.target, pages }),
    creative: pages ? creativeView({ area: pages.creative, cards, props: required }) : null,
    campaigns: pages ? campaignView({ area: pages.campaigns, cards, props: required }) : null,
    operations: pages ? operationsView({ area: pages.operations }) : null,
  };
}
/** Treat absent optional page data and empty lists alike, without hiding halt evidence.
 * @returns First-use copy, or null when this page has content or uses another canvas.
 * @complexity O(1) time/space; no I/O or inferred campaign status.
 */
function canvasEmptyState(required: { target: NavigationTarget; pages: StudioSnapshot["pages"] }): CanvasEmptyStateModel | null {
  const pages = required.pages;
  switch (required.target) {
    case "campaigns": return !pages || (pages.campaigns.drafts.length === 0 && pages.campaigns.halts.length === 0) ? emptyStates.campaigns : null;
    case "media-library": return !pages || pages.creative.assets.length === 0 ? emptyStates["media-library"] : null;
    case "activity": return !pages || pages.operations.activity.length === 0 ? emptyStates.activity : null;
    default: return null;
  }
}
/** Null money carries no evidence of zero cost; Intl handles currency precision. */
function formatMoney(required: { money: Money | null }): string {
  if (required.money === null) return "Unavailable · not confirmed free";
  const format = new Intl.NumberFormat("en-US", { style: "currency", currency: required.money.currency });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(required.money.minorUnits / 10 ** digits);
}
/** Association is a lookup, not a policy decision; ApprovalCard validates server choices. */
function approvalProps(required: { id: string | null; cards: ReadonlyMap<string, ConfirmationCard>; props: WorkspaceCanvasProps }): ApprovalCardProps | null {
  const card = required.id ? required.cards.get(required.id) : undefined;
  if (!card) return null;
  return { card, api: required.props.api, runtime: required.props.runtime, sample: required.props.snapshot.mode === "sample" };
}
function creativeView(required: { area: Pages["creative"]; cards: ReadonlyMap<string, ConfirmationCard>; props: WorkspaceCanvasProps }): CreativeMediaModel {
  const originals = new Map(required.area.assets.map(asset => [asset.id, asset.title]));
  return {
    generations: required.area.generations.map(item => ({ ...item,
      quoteText: formatMoney({ money: item.quote }), estimatedText: formatMoney({ money: item.estimated }), actualText: formatMoney({ money: item.actual }),
      classificationText: allowanceLabels[item.allowanceClassification],
      approval: item.status === "review" ? approvalProps({ id: item.approvalCardId, cards: required.cards, props: required.props }) : null,
    })),
    assets: required.area.assets.map(item => ({ ...item, costText: formatMoney({ money: item.cost }),
      originalTitle: item.originalId ? originals.get(item.originalId) ?? "Original details unavailable" : "Original asset",
    })),
  };
}
function campaignView(required: { area: Pages["campaigns"]; cards: ReadonlyMap<string, ConfirmationCard>; props: WorkspaceCanvasProps }): CampaignSafetyModel {
  return {
    drafts: required.area.drafts.map(item => ({ ...item, approval: item.review === "ready" ? approvalProps({ id: item.approvalCardId, cards: required.cards, props: required.props }) : null })),
    halts: required.area.halts,
    allowances: required.area.allowances.map(item => ({ ...item, dailyText: formatMoney({ money: item.daily }), usedText: formatMoney({ money: item.used }), reservedText: formatMoney({ money: item.reserved }), remainingText: formatMoney({ money: item.remaining }) })),
  };
}
function operationsView(required: { area: Pages["operations"] }): OperationsModel {
  return { ...required.area, reports: required.area.reports.map(item => ({ ...item, sourceText: sourceLabels[item.source], cacText: item.cac === null ? "Unavailable" : formatMoney({ money: item.cac }), restatementText: item.restates ? "Restates " + item.restates : "No restatement recorded" })) };
}
function canvasHeading(required: { target: NavigationTarget }): string {
  if (required.target === "workspaces") return "Your next chapter";
  if (required.target === "creative") return "Ideas taking shape";
  if (required.target === "media-library") return "A library with a story";
  return "In this workspace";
}
