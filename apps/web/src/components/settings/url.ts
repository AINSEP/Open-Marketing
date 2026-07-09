/**
 * Returns the input URL only when it parses and uses https; otherwise
 * `undefined`. Used to gate user-supplied / catalog-provided links (docs,
 * install, provider pages) so we never render an http or malformed href.
 *
 * Shared by the SettingsDialog monolith and the extracted settings sections
 * (e.g. MediaProvidersSection) — promoted out of the dialog so both sides of
 * the section-registry split call the same helper rather than duplicating it.
 */
export function sanitizeHttpsUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}
