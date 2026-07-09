'use client';

// React adapter for the agui-copilot interface. Wraps CopilotKit's provider so
// the rest of the app (App.tsx) never imports @copilotkit directly. The runtime
// endpoint is same-origin (/api/copilotkit) — the daemon serves this SPA in
// prod and proxies it in dev (Vite / Next).

import type { ReactNode } from 'react';
import { CopilotKitProvider } from '@copilotkit/react-core/v2';

import '@copilotkit/react-core/v2/styles.css';
import './copilot-theme.css';

export function CopilotProvider({ children }: { children: ReactNode }) {
  return (
    <CopilotKitProvider runtimeUrl="/api/copilotkit" useSingleEndpoint>
      {children}
    </CopilotKitProvider>
  );
}
