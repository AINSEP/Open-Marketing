import { parseBoundary } from '@open-marketing/contracts';
import type { Outcome } from '@open-marketing/contracts';
import type { PlacementCropPreset, PlacementCropRequest } from './types.js';
import { fail, presetSchema } from './validation.js';

/** Invalid or ambiguous preset configuration fails closed before transform effects. @complexity O(p), p <=100. */
export function selectPreset(required: { presets: readonly PlacementCropPreset[]; request: PlacementCropRequest }): Outcome<PlacementCropPreset> {
  if (required.presets.length > 100) return fail({ code: 'limit_exceeded', message: 'Too many placement presets' });
  const matching = required.presets.filter(preset => preset.placement === required.request.placement && preset.version === required.request.presetVersion);
  if (matching.length !== 1) return fail({ code: 'invalid_input', message: 'Unknown or ambiguous placement preset' });
  return parseBoundary({ schema: presetSchema, input: matching[0] });
}
