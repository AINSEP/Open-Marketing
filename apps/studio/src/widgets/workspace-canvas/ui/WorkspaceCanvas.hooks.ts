import type { Money, NavigationTarget } from "@open-marketing/contracts";
import type { StudioSnapshot } from "../../../shared/api/index.js";
export interface WorkspaceCanvasProps { readonly target: NavigationTarget; readonly snapshot: StudioSnapshot; readonly onOpenChat: () => void }
/** Presentation derives only from the injected read model, never backend feature imports. */
export function useWorkspaceCanvas(required: WorkspaceCanvasProps) {
  return {
    rows: required.snapshot.rows[required.target] ?? [], metrics: required.snapshot.metrics,
    daily: formatMoney({ money: required.snapshot.allowance.daily }), remaining: formatMoney({ money: required.snapshot.allowance.remaining }),
    timezone: required.snapshot.allowance.timezone,
    heading: canvasHeading({ target: required.target }),
  };
}
function formatMoney(required: { money: Money }): string {
  const format = new Intl.NumberFormat("en-US", { style: "currency", currency: required.money.currency });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(required.money.minorUnits / 10 ** digits);
}
function canvasHeading(required: { target: NavigationTarget }): string {
  if (required.target === "workspaces") return "Your next chapter";
  if (required.target === "creative") return "Ideas taking shape";
  if (required.target === "media-library") return "A library with a story";
  return "In this workspace";
}
