import { parseBoundary, idSchema } from '@open-marketing/contracts';
import type { CallContext, Outcome, Scope, ObserverPort } from '@open-marketing/contracts';
import type { AssetCost, AssetProvenance, PlacementCrop, ProvenanceLink } from './types.js';
import type { MediaRepoPort } from './ports.js';
import { boundary } from './boundary.js';
import { checkContext, costSchema, cropSchema, fail, linkSchema, success } from './validation.js';

/** Internal storage seam has two concrete implementations: memory and injected SQL. */
export interface EvidenceRow { readonly kind: 'provenance' | 'link' | 'cost' | 'crop'; readonly key: string; readonly operationId: string; readonly payload: string }
export interface EvidenceStore {
  append(required: { context: CallContext; row: EvidenceRow }): Promise<Outcome<void>>;
  read(required: { context: CallContext; operationId: string }): Promise<Outcome<readonly EvidenceRow[]>>;
}
/** Idempotent append policy shared by memory/SQL; evidence survives missing assets and partial association writes.
 * Corrections append a replacement observation, never update or net signed money.
 * @complexity O(e) bounded at 1,000 rows per evidence read. @example createEvidenceRepo({ store })
 */
export function createEvidenceRepo(required: { store: EvidenceStore; scope?: Scope }, optional?: { observer?: ObserverPort }): MediaRepoPort {
  return {
    async saveCrop(input, options) {
      const context = checkContext({ context: input.context, options, scope: required.scope });
      if (!context.ok) return context;
      const crop = parseBoundary({ schema: cropSchema, input: input.crop });
      if (!crop.ok) return crop;
      if (crop.value.rendition.workspaceId !== input.context.scope.workspaceId) return fail({ code: 'forbidden', message: 'Crop scope mismatch' });
      return boundary({ context: input.context, operation: 'media.saveCrop', run: async () => {
        const row: EvidenceRow = { kind: 'crop', key: JSON.stringify([crop.value.assetId, crop.value.placement, crop.value.presetVersion]), operationId: crop.value.cropId, payload: JSON.stringify(crop.value) };
        const appended = await required.store.append({ context: input.context, row });
        if (!appended.ok) return appended;
        return success({ value: crop.value });
      } }, optional);
    },
    async appendProvenance(input, options) {
      const context = checkContext({ context: input.context, options, scope: required.scope });
      if (!context.ok) return context;
      const link = parseBoundary({ schema: linkSchema, input: input.link });
      if (!link.ok) return link;
      return boundary({ context: input.context, operation: 'media.appendProvenance', run: async () => appendLink({ store: required.store, context: input.context, link: link.value }) }, optional);
    },
    async appendCost(input, options) {
      const context = checkContext({ context: input.context, options, scope: required.scope });
      if (!context.ok) return context;
      const cost = parseBoundary({ schema: costSchema, input: input.cost });
      if (!cost.ok) return cost;
      return boundary({ context: input.context, operation: 'media.appendCost', run: async () => appendCost({ store: required.store, context: input.context, cost: cost.value }) }, optional);
    },
    async evidence(input, options) {
      const context = checkContext({ context: input.context, options, scope: required.scope });
      if (!context.ok) return context;
      if (!idSchema.safeParse(input.operationId).success) return fail({ code: 'invalid_input', message: 'Invalid operation ID' });
      return boundary({ context: input.context, operation: 'media.evidence', run: async () => {
        const rows = await required.store.read(input);
        if (!rows.ok) return rows;
        return decodeEvidence({ rows: rows.value });
      } }, optional);
    },
  };
}
/** Root evidence is write-once per operation; later links may attach the same evidence to an asset. @complexity O(1) writes. */
async function appendLink(required: { store: EvidenceStore; context: CallContext; link: ProvenanceLink }): Promise<Outcome<void>> {
  const { provenance, assetId } = required.link;
  const root = await required.store.append({ context: required.context, row: { kind: 'provenance', key: provenance.operationId, operationId: provenance.operationId, payload: JSON.stringify(provenance) } });
  if (!root.ok || assetId === undefined) return root;
  return required.store.append({ context: required.context, row: { kind: 'link', key: JSON.stringify([provenance.operationId, assetId]), operationId: provenance.operationId, payload: JSON.stringify(required.link) } });
}
/** Corrections must reference an existing observation in the same operation and currency. @complexity O(e). */
async function appendCost(required: { store: EvidenceStore; context: CallContext; cost: AssetCost }): Promise<Outcome<void>> {
  if (required.cost.correctionOf) {
    const rows = await required.store.read({ context: required.context, operationId: required.cost.operationId });
    if (!rows.ok) return rows;
    const previous = rows.value.find(row => row.kind === 'cost' && row.key === required.cost.correctionOf);
    if (!previous) return fail({ code: 'conflict', message: 'Correction target is absent' });
    const parsed = costSchema.safeParse(JSON.parse(previous.payload));
    if (!parsed.success) return fail({ code: 'unavailable', message: 'Invalid persisted cost' });
    if (parsed.data.amount.currency !== required.cost.amount.currency) return fail({ code: 'conflict', message: 'Correction currency mismatch' });
  }
  return required.store.append({ context: required.context, row: { kind: 'cost', key: required.cost.observationId, operationId: required.cost.operationId, payload: JSON.stringify(required.cost) } });
}
/** Stored JSON is tainted until parsed; malformed rows fail the complete read. @complexity O(e), bounded. */
function decodeEvidence(required: { rows: readonly EvidenceRow[] }): Outcome<{ provenance: readonly ProvenanceLink[]; costs: readonly AssetCost[] }> {
  const provenance: ProvenanceLink[] = [];
  const costs: AssetCost[] = [];
  const linked = required.rows.filter(row => row.kind === 'link');
  for (const row of required.rows) {
    const decoded = decodeRow({ row, hasLinks: linked.length > 0 });
    if (!decoded.ok) return decoded;
    if (decoded.value.link) provenance.push(decoded.value.link);
    if (decoded.value.cost) costs.push(decoded.value.cost);
  }
  return success({ value: { provenance, costs } });
}
function decodeRow(required: { row: EvidenceRow; hasLinks: boolean }): Outcome<{ link?: ProvenanceLink; cost?: AssetCost }> {
  const input: unknown = JSON.parse(required.row.payload);
  if (required.row.kind === 'cost') {
    const cost = costSchema.safeParse(input);
    if (!cost.success) return fail({ code: 'unavailable', message: 'Invalid persisted cost' });
    return success({ value: { cost: cost.data } });
  }
  if (required.row.kind === 'provenance' && required.hasLinks) return success({ value: {} });
  if (required.row.kind === 'crop') return success({ value: {} });
  let candidate = input;
  if (required.row.kind === 'provenance') candidate = { provenance: input as AssetProvenance };
  const link = linkSchema.safeParse(candidate);
  if (!link.success) return fail({ code: 'unavailable', message: 'Invalid persisted provenance' });
  return success({ value: { link: link.data } });
}
