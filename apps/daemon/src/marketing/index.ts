import { registerCapability } from '../agui-copilot/registry.js';
import { createMarketingCapability } from './capability.js';

// Register the marketing assistant as the default agui-copilot capability.
// Importing this module for its side effect (the daemon entrypoint does) makes
// the capability available to the CopilotKit runtime. Imports only the
// registry (no @copilotkit/@ag-ui pulled into the marketing module graph).
registerCapability('default', 'Open Marketing workspace assistant', createMarketingCapability());
