/**
 * Re-export shim for the refactored Settings dialog.
 * The monolithic file has been moved to settings/SettingsDialog.tsx
 * and will be gradually refactored into a section-registry pattern.
 * This file maintains backward compatibility for existing imports.
 */

export {
  mergeProviderModelOptions,
  providerModelsCacheKey,
  type SettingsSection,
  type SettingsHighlight,
  type AgentRefreshOptions,
  testStatusVariant,
  shouldShowCustomModelInput,
  canRunProviderConnectionTest,
  canFetchProviderModels,
  isValidApiBaseUrl,
  updateCurrentApiProtocolConfig,
  updateAgentCliEnvValue,
  reconcileAmrProfileEnv,
  reconcileAmrModelChoice,
  agentRefreshOptionsForConfig,
  amrWalletValueLabel,
  shouldEnableSettingsSave,
  sanitizeSettingsSavePayload,
  switchApiProtocolConfig,
  SettingsDialog,
  type ComposioCredentialState,
  deriveComposioCredentialState,
  ConnectorSection,
  persistConfigAndRunOrbit,
  configForManualOrbitRun,
  isOrbitRunDisabled,
} from './settings/SettingsDialog';
