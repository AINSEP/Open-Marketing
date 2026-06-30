import type { Dict } from '../../i18n/types';
import type { IconName } from '../Icon';
import type { SettingsSection } from './SettingsDialog';

/**
 * Single source of truth for the Settings dialog sidebar.
 *
 * The dialog used to hand-write one `<button>` per section (~190 lines of
 * repetitive JSX); order, icons, and labels lived inline and could drift from
 * the `SettingsSection` union and the header map. This registry centralizes
 * the sidebar: add / remove / reorder a section by editing exactly one row and
 * the shell renders whatever this array contains.
 *
 * This is step 1 of the incremental extraction — it owns the *navigation*
 * metadata only. The per-section content still lives in `SettingsDialog.tsx`
 * and is moved out one section at a time (see `sections/`). The `SettingsSection`
 * type is imported type-only, so this module has no runtime dependency on the
 * dialog and the value-import back the other way stays acyclic.
 */

/** The dialog's translate fn, matching `useI18n().t`. */
type SettingsT = (key: keyof Dict, vars?: Record<string, string | number>) => string;

export interface SettingsNavItem {
  id: SettingsSection;
  icon: IconName;
  /** Sidebar nav label — the bold first line. */
  title: (t: SettingsT) => string;
  /**
   * Sidebar nav sublabel — the muted second line. A function (not a bare i18n
   * key) so composed labels (`"Local CLI / API"`) and the one literal
   * (`"Image / video / audio"`) render identically to the old inline JSX.
   */
  subtitle: (t: SettingsT) => string;
}

export const SETTINGS_NAV: SettingsNavItem[] = [
  {
    id: 'execution',
    icon: 'sliders',
    title: (t) => t('settings.envConfigure'),
    subtitle: (t) => `${t('settings.localCli')} / ${t('settings.modeApiMeta')}`,
  },
  {
    id: 'instructions',
    icon: 'edit',
    title: (t) => t('settings.instructionsTitle'),
    subtitle: (t) => t('settings.instructionsNavSub'),
  },
  { id: 'memory', icon: 'history', title: (t) => t('settings.memory'), subtitle: (t) => t('settings.memoryHint') },
  {
    id: 'media',
    icon: 'image',
    title: (t) => t('settings.mediaProviders'),
    // Literal in the original JSX — kept verbatim to avoid a behavior change.
    subtitle: () => 'Image / video / audio',
  },
  { id: 'skills', icon: 'grid', title: (t) => t('settings.skills'), subtitle: (t) => t('settings.skillsHint') },
  {
    id: 'mcpClient',
    icon: 'sparkles',
    title: (t) => t('settings.externalMcpTitle'),
    subtitle: (t) => t('settings.externalMcpHint'),
  },
  {
    id: 'composio',
    icon: 'sliders',
    title: (t) => t('connectors.title'),
    subtitle: (t) => t('settings.connectorsNavHint'),
  },
  {
    id: 'integrations',
    icon: 'link',
    title: (t) => t('settings.mcpServerTitle'),
    subtitle: (t) => t('settings.mcpServerHint'),
  },
  { id: 'language', icon: 'languages', title: (t) => t('settings.language'), subtitle: (t) => t('settings.languageHint') },
  {
    id: 'appearance',
    icon: 'sun-moon',
    title: (t) => t('settings.appearance'),
    subtitle: (t) => t('settings.appearanceHint'),
  },
  {
    id: 'critiqueTheater',
    icon: 'comment',
    title: (t) => t('critiqueTheater.settingsNav'),
    subtitle: (t) => t('critiqueTheater.settingsNavHint'),
  },
  {
    id: 'notifications',
    icon: 'bell',
    title: (t) => t('settings.notifications'),
    subtitle: (t) => t('settings.notificationsHint'),
  },
  { id: 'pet', icon: 'sparkles', title: (t) => t('pet.navTitle'), subtitle: (t) => t('pet.navHint') },
  {
    id: 'designSystems',
    icon: 'draw',
    title: (t) => t('settings.designSystems'),
    subtitle: (t) => t('settings.designSystemsHint'),
  },
  {
    id: 'projectLocations',
    icon: 'folder',
    title: (t) => t('settings.projectLocations'),
    subtitle: (t) => t('settings.projectLocationsHint'),
  },
  { id: 'privacy', icon: 'eye', title: (t) => t('settings.privacy'), subtitle: (t) => t('settings.privacyHint') },
  { id: 'about', icon: 'settings', title: (t) => t('settings.about'), subtitle: (t) => t('settings.aboutHint') },
];
