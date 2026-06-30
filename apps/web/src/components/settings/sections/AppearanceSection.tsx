import { useLayoutEffect } from 'react';
import type { CSSProperties, Dispatch, SetStateAction } from 'react';

import { trackSettingsAppearanceClick } from '../../../analytics/events';
import { useAnalytics } from '../../../analytics/provider';
import { useI18n } from '../../../i18n';
import {
  ACCENT_SWATCHES,
  DEFAULT_ACCENT_COLOR,
  applyAppearanceToDocument,
  normalizeAccentColor,
} from '../../../state/appearance';
import type { AppConfig, AppTheme } from '../../../types';
import { Icon } from '../../Icon';

// Theme segmented-control options. Lives with the section that renders it —
// it's the only consumer.
const THEMES: Array<{
  value: AppTheme;
  labelKey: 'settings.themeSystem' | 'settings.themeLight' | 'settings.themeDark';
  icon?: 'sun' | 'moon';
}> = [
  { value: 'system', labelKey: 'settings.themeSystem' },
  { value: 'light', labelKey: 'settings.themeLight', icon: 'sun' },
  { value: 'dark', labelKey: 'settings.themeDark', icon: 'moon' },
];

/**
 * Appearance settings: theme (system/light/dark) + accent color.
 *
 * Extracted verbatim from the SettingsDialog monolith as the first content
 * section moved under `sections/`. It edits the draft `AppConfig` through the
 * `cfg`/`setCfg` pair the dialog owns, and previews theme/accent live via
 * `applyAppearanceToDocument` (the dialog reverts on cancel).
 */
export function AppearanceSection({
  cfg,
  setCfg,
}: {
  cfg: AppConfig;
  setCfg: Dispatch<SetStateAction<AppConfig>>;
}) {
  const { t } = useI18n();
  const analytics = useAnalytics();
  const current = cfg.theme ?? 'system';
  const currentAccent = normalizeAccentColor(cfg.accentColor) ?? DEFAULT_ACCENT_COLOR;
  const accentLabel = t('pet.fieldAccent');
  const defaultAccentLabel = t('pet.fieldAccentDefault');
  const customAccentLabel = t('pet.fieldAccentCustom');

  // Apply the draft theme immediately so the user sees a live preview
  // before hitting Save. SettingsDialog's cleanup reverts this on cancel.
  useLayoutEffect(() => {
    applyAppearanceToDocument({
      theme: current,
      accentColor: currentAccent,
    });
  }, [current, currentAccent]);

  const setAccentColor = (color: string) => {
    setCfg((c) => ({ ...c, accentColor: normalizeAccentColor(color) ?? c.accentColor ?? DEFAULT_ACCENT_COLOR }));
  };

  return (
    <section className="settings-section">
      <div className="seg-control" role="group" aria-label={t('settings.appearance')} style={{ '--seg-cols': THEMES.length } as CSSProperties}>
        {THEMES.map(({ value, labelKey, icon }) => (
          <button
            key={value}
            type="button"
            className={'seg-btn' + (current === value ? ' active' : '')}
            aria-pressed={current === value}
            onClick={() => {
              // P1 ui_click area=appearance — `system|light|dark` only
              // emits from the segmented control; accent swatch picks
              // use `accent_color` with the swatch hex below.
              if (value === 'system' || value === 'light' || value === 'dark') {
                trackSettingsAppearanceClick(analytics.track, {
                  page_name: 'settings',
                  area: 'appearance',
                  element: value,
                });
              }
              setCfg((c) => ({ ...c, theme: value }));
            }}
          >
            {icon ? <Icon name={icon} size={14} aria-hidden="true" /> : null}
            <span className="seg-title">{t(labelKey)}</span>
          </button>
        ))}
      </div>
      <div className="field">
        <span className="field-label">{accentLabel}</span>
        <div className="pet-swatches" role="radiogroup" aria-label={accentLabel}>
          {ACCENT_SWATCHES.map((color) => {
            const active = currentAccent === color;
            return (
              <button
                key={color}
                type="button"
                className={`pet-swatch${active ? ' active' : ''}`}
                style={{ background: color }}
                aria-label={color === DEFAULT_ACCENT_COLOR ? defaultAccentLabel : color}
                aria-checked={active}
                role="radio"
                onClick={() => {
                  trackSettingsAppearanceClick(analytics.track, {
                    page_name: 'settings',
                    area: 'appearance',
                    element: 'accent_color',
                    color,
                  });
                  setAccentColor(color);
                }}
              />
            );
          })}
          <input
            type="color"
            aria-label={customAccentLabel}
            className="pet-swatch-picker"
            value={currentAccent}
            onChange={(e) => setAccentColor(e.target.value)}
          />
        </div>
      </div>
    </section>
  );
}
