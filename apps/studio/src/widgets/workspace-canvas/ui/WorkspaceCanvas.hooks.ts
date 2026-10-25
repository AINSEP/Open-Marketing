import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import { isSafeUiValue } from "../../../shared/api/index.js";
import type { ConfirmationCard, Money, NavigationTarget } from "@open-marketing/contracts";
import type { StudioApiPort, StudioSnapshot, StudioRuntime, StudioMetric, StudioRow } from "../../../shared/api/index.js";
import type { ApprovalCardProps } from "../../../features/approve/index.js";

/** The shell supplies the same API/runtime used by chat; pages never construct adapters. */
export interface WorkspaceCanvasProps {
  readonly target: NavigationTarget; readonly snapshot: StudioSnapshot;
  readonly cards?: readonly ConfirmationCard[];
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
export type DraftView = Draft & { readonly approval: ApprovalCardProps | null; readonly operationId: string | null; readonly api: StudioApiPort; readonly runtime: StudioRuntime };
interface DeploymentOperation { readonly cardId: string; readonly operationId: string }
export interface CampaignLaunchReviewProps { readonly operationId: string; readonly approval: ApprovalCardProps | null; readonly api: StudioApiPort; readonly runtime: StudioRuntime }
export type AllowanceView = Allowance & { readonly dailyText: string; readonly usedText: string; readonly reservedText: string; readonly remainingText: string };
export type ReportView = Report & { readonly sourceText: string; readonly cacText: string; readonly restatementText: string };
/** Display models retain API evidence verbatim alongside formatted money and card associations. */
export interface CreativeMediaModel { readonly generations: readonly GenerationView[]; readonly assets: readonly AssetView[] }
export interface CampaignSafetyModel { readonly drafts: readonly DraftView[]; readonly halts: Pages["campaigns"]["halts"]; readonly allowances: readonly AllowanceView[] }
export interface OperationsModel extends Omit<Pages["operations"], "reports"> { readonly reports: readonly ReportView[] }
/** Page copy and destinations for the three first-use canvas states. */
export interface CanvasEmptyStateModel { readonly message: string; readonly linkLabel: string; readonly href: string; readonly assistantLabel: string }
export interface WorkspaceCanvasModel {
  readonly rows: readonly StudioRow[]; readonly metrics: readonly StudioMetric[];
  readonly creative: CreativeMediaModel | null; readonly campaigns: CampaignSafetyModel | null; readonly operations: OperationsModel | null;
  readonly emptyState: CanvasEmptyStateModel | null; readonly launches: readonly CampaignLaunchReviewProps[];
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
 * @complexity O(n) time/space across bounded snapshot lists; retains at most 50 deployment identities, no I/O.
 */
export function useWorkspaceCanvas(required: WorkspaceCanvasProps): WorkspaceCanvasModel {
  const pages = required.snapshot.pages;
  const current = required.cards ?? required.snapshot.cards;
  const cards = new Map(current.map(card => [card.cardId, card]));
  const [retained, setRetained] = useState<readonly DeploymentOperation[]>([]);
  const deployments = useMemo(() => retainDeployments({ current, retained }), [current, retained]);
  useEffect(() => { setRetained(deployments); }, [deployments]);
  const operations = new Map(deployments.map(item => [item.cardId, item.operationId]));
  const draftCards = new Set(pages?.campaigns.drafts.map(draft => draft.approvalCardId));
  return {
    launches: deployments.filter(item => !draftCards.has(item.cardId)).map(item => ({ operationId: item.operationId, approval: approvalProps({ id: item.cardId, cards, props: required }), api: required.api, runtime: required.runtime })),
    rows: required.snapshot.rows[required.target] ?? [], metrics: required.snapshot.metrics.map(metric => ({ ...metric, value: metric.value.replace(/^0+(?=\d+$)/, "") })),
    emptyState: canvasEmptyState({ target: required.target, pages }),
    creative: pages ? creativeView({ area: pages.creative, cards, props: required }) : null,
    campaigns: pages ? campaignView({ area: pages.campaigns, cards, operations, props: required }) : null,
    operations: pages ? operationsView({ area: pages.operations }) : null,
  };
}
/** Retain identities for outcome reads after a session removes a resolved card; never retain authority.
 * @returns The previous list unchanged when no deployment identity changed.
 * @complexity O(n) time/space over at most 50 retained and 50 current cards, capped to the latest 50 operations.
 */
function retainDeployments(required: { current: readonly ConfirmationCard[]; retained: readonly DeploymentOperation[] }): readonly DeploymentOperation[] {
  const known = new Map(required.retained.map(item => [item.operationId, item]));
  let changed = false;
  for (const card of required.current) {
    if (card.arguments.tool !== 'om_campaign_deploy_paused') continue;
    if (known.get(card.operationId)?.cardId === card.cardId) continue;
    known.set(card.operationId, { cardId: card.cardId, operationId: card.operationId }); changed = true;
  }
  return changed ? [...known.values()].slice(-50) : required.retained;
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
function campaignView(required: { area: Pages["campaigns"]; cards: ReadonlyMap<string, ConfirmationCard>; operations: ReadonlyMap<string, string>; props: WorkspaceCanvasProps }): CampaignSafetyModel {
  return {
    drafts: required.area.drafts.map(item => ({ ...item, api: required.props.api, runtime: required.props.runtime,
      operationId: required.operations.get(item.approvalCardId ?? '') ?? null, approval: item.review === "ready" ? approvalProps({ id: item.approvalCardId, cards: required.cards, props: required.props }) : null })),
    halts: required.area.halts,
    allowances: required.area.allowances.map(item => ({ ...item, dailyText: formatMoney({ money: item.daily }), usedText: formatMoney({ money: item.used }), reservedText: formatMoney({ money: item.reserved }), remainingText: formatMoney({ money: item.remaining }) })),
  };
}
function operationsView(required: { area: Pages["operations"] }): OperationsModel {
  return { ...required.area, reports: required.area.reports.map(item => ({ ...item, sourceText: sourceLabels[item.source], cacText: item.cac === null ? "Unavailable" : formatMoney({ money: item.cac }), restatementText: item.restates ? "Restates " + item.restates : "No restatement recorded" })) };
}
const operationStatusText = { pending: 'Awaiting server outcome', cancelled: 'Cancelled', interrupted: 'Interrupted · request a fresh review', unknown: 'Unknown · reconciling' };
const referenceSchema = z.union([z.array(z.string().min(1).max(256)).max(500), z.record(z.string().max(256), z.string().min(1).max(256)).refine(value => Object.keys(value).length <= 500)]);
const launchEvidenceSchema = z.object({ complete: z.boolean(),
  entities: z.array(z.strictObject({ operationId: z.string().max(256), entityId: z.string().max(256), state: z.enum(['paused', 'draft']) })).max(500),
  outcomes: z.array(z.object({ operationId: z.string().min(1).max(256), tool: z.string().min(1).max(256), connectionId: z.string().max(256), accountId: z.string().max(256).nullable(),
    result: z.object({ status: z.enum(['acknowledged', 'unknown', 'failed', 'pending', 'not_attempted']), entityIds: z.array(z.string().min(1).max(256)).max(500).optional(), references: referenceSchema.optional() }).passthrough(),
  })).min(1).max(4),
});
export interface LaunchOutcomeRow { readonly id: string; readonly vendor: string; readonly account: string; readonly status: string; readonly references: string }
/** Parse the two existing deployment outputs (final submission or read-only reconciliation).
 * A mixed-invalid batch rejects intact; unknown receipts retain references without implying success.
 * @example parseLaunchOutcomes({ input: operation.output });
 * @complexity O(b) time/space; b <=256 KiB, <=4 destinations and <=500 entities.
 */
export function parseLaunchOutcomes(required: { input: unknown }): { rows: readonly LaunchOutcomeRow[]; status: string } | null {
  if (!isSafeUiValue({ value: required.input, maxCharacters: 262144 })) return null;
  const submitted = z.object({ status: z.literal('submitted'), hierarchy: launchEvidenceSchema }).safeParse(required.input);
  const evidence = submitted.success ? submitted.data.hierarchy : launchEvidenceSchema.safeParse(required.input).data;
  if (!evidence || new Set(evidence.outcomes.map(item => item.operationId)).size !== evidence.outcomes.length) return null;
  const rows = evidence.outcomes.map(item => ({ id: item.operationId, vendor: vendorLabel({ tool: item.tool }), account: item.connectionId + ' / ' + (item.accountId ?? 'Unknown account'),
    status: launchOutcomeStatus({ item, entities: evidence.entities }), references: JSON.stringify({ entityIds: item.result.entityIds ?? [], references: item.result.references ?? [] }),
  }));
  return { rows, status: evidence.complete ? 'Deployment evidence received' : 'Partial deployment · reconcile unresolved destinations' };
}
/** Only explicit readback establishes paused/draft state; acknowledged IDs alone are insufficient. */
function launchOutcomeStatus(required: { item: z.infer<typeof launchEvidenceSchema>['outcomes'][number]; entities: z.infer<typeof launchEvidenceSchema>['entities'] }): string {
  const { item } = required;
  if (item.result.status === 'not_attempted') return 'Not attempted';
  if (item.result.status === 'failed') return 'Failed · partial references preserved';
  if (item.result.status !== 'acknowledged') return 'Unknown · reconciling';
  const states = required.entities.filter(entity => entity.operationId === item.operationId);
  if (!states.length || !item.result.entityIds?.length) return 'Created · serving state unconfirmed';
  if (!item.result.entityIds.every(id => states.some(entity => entity.entityId === id))) return 'Created · readback incomplete';
  if (states.every(entity => entity.state === 'draft')) return 'Created · draft';
  return states.every(entity => entity.state === 'paused') ? 'Created · paused' : 'Created · mixed readback';
}
function vendorLabel(required: { tool: string }): string {
  const vendor = ['google_ads', 'linkedin_ads', 'meta_ads', 'tiktok_ads'].find(id => required.tool.startsWith('vendor_' + id + '_'));
  return vendor?.replaceAll('_', ' ') ?? required.tool;
}
/** Inspect only the operation associated with this server card. Reconcile dispatches the named read
 * tool with a fresh operation ID; it never invokes deploy/create/activate or retries an unknown write.
 * @example useCampaignOutcome({ operationId, api, runtime });
 * @complexity O(1) request state, one bounded request per click with injected HTTP cancellation.
 */
export function useCampaignOutcome(required: { operationId: string | null; api: StudioApiPort; runtime: StudioRuntime }) {
  const [rows, setRows] = useState<readonly LaunchOutcomeRow[]>([]);
  const [status, setStatus] = useState('Read the launch operation after recording your choice.');
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const lock = useRef(false);
  useEffect(() => { const active = required.runtime.abort(); controller.current = active; lock.current = false; return () => active.abort(); }, [required.runtime]);
  const accept = (input: { output: unknown }): void => {
    const result = parseLaunchOutcomes({ input: input.output });
    if (!result) { setStatus('Deployment evidence unavailable · reconcile before any further action'); return; }
    setRows(result.rows); setStatus(result.status);
  };
  const read = async (input: { action: 'refresh' | 'reconcile' }): Promise<void> => {
    if (lock.current || !required.operationId) return;
    lock.current = true; setBusy(true);
    const signal = controller.current?.signal;
    try {
      const api = required.api;
      const result = input.action === 'refresh' ? await api.operation?.({ operationId: required.operationId, signal })
        : await api.tool?.({ call: { name: 'om_campaign_reconcile_deployment', operationId: required.runtime.ids.next({}), input: { operationId: required.operationId } }, signal });
      if (signal?.aborted) return;
      if (!result?.ok) { setStatus('Outcome unavailable · previous references retained; reconcile before another launch'); return; }
      if (result.value.status === 'completed') { accept({ output: result.value.output }); return; }
      setStatus(operationStatusText[result.value.status]);
    } catch { if (!signal?.aborted) setStatus('Outcome unavailable · previous references retained'); }
    finally { lock.current = false; if (!signal?.aborted) setBusy(false); }
  };
  const refresh = (): void => { void read({ action: 'refresh' }); };
  const reconcile = (): void => { void read({ action: 'reconcile' }); };
  return { rows, status, busy, available: required.operationId !== null, refresh, reconcile };
}

