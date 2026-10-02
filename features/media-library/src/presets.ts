import type { PlacementCropPreset } from './types.js';
/** Provider-neutral ad geometry; adapters register versioned Jini transforms from this data. */
export const PLACEMENT_CROP_PRESETS: readonly PlacementCropPreset[] = [
    { placement: 'ad-square', version: 1, params: { width: 1080, height: 1080, fit: 'cover', format: 'webp' } },
    { placement: 'ad-portrait', version: 1, params: { width: 1080, height: 1350, fit: 'cover', format: 'webp' } },
    { placement: 'ad-story', version: 1, params: { width: 1080, height: 1920, fit: 'cover', format: 'webp' } },
    { placement: 'ad-landscape', version: 1, params: { width: 1200, height: 628, fit: 'cover', format: 'webp' } },
];
