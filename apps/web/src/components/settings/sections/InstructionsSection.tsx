import type { Dispatch, SetStateAction } from 'react';

import { useI18n } from '../../../i18n';
import type { AppConfig } from '../../../types';

/**
 * Custom instructions settings: a single free-text field whose contents are
 * prepended to every agent prompt.
 *
 * Extracted verbatim from the SettingsDialog monolith. It edits the draft
 * `AppConfig` through the `cfg`/`setCfg` pair the dialog owns; an empty string
 * is normalized back to `undefined` so a cleared field doesn't persist as `""`.
 */
export function InstructionsSection({
  cfg,
  setCfg,
}: {
  cfg: AppConfig;
  setCfg: Dispatch<SetStateAction<AppConfig>>;
}) {
  const { t } = useI18n();
  return (
    <section className="settings-section settings-section-card instructions-rules-section">
      <div className="memory-field-block instructions-rules-card">
        <div className="memory-block-head">
          <div>
            <h4>{t('settings.customInstructionsTitle')}</h4>
            <p className="hint">
              {t('settings.customInstructionsDesc')}
            </p>
          </div>
        </div>
        <textarea
          className="custom-instructions-input memory-global-rules-input instructions-rules-input"
          rows={5}
          maxLength={5000}
          placeholder={t('settings.customInstructionsPlaceholder')}
          value={cfg.customInstructions ?? ''}
          onChange={(event) =>
            setCfg({
              ...cfg,
              customInstructions: event.target.value || undefined,
            })
          }
        />
      </div>
    </section>
  );
}
