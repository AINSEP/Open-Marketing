'use client';

// The agui-copilot chat sidebar — the system assistant surface, rendered
// alongside Open Marketing's native UI. Mounted inside <CopilotProvider>. The page
// context and suggestions below are the current default (marketing) content;
// they are data, not structure, and swap out as more capabilities are exposed.

import {
  CopilotSidebar as CopilotKitSidebar,
  useAgentContext,
  useConfigureSuggestions,
} from '@copilotkit/react-core/v2';

export function CopilotSidebar() {
  // Surface a minimal page-context snapshot. The daemon capability keys off a
  // description containing "open marketing" (case-insensitive) and reads
  // `value` as JSON, using `engineId` to route freeform prompts to a detected
  // local CLI.
  useAgentContext({
    description: 'Open Marketing shell context',
    value: {
      view: 'home',
      engineId: null,
      engineName: null,
    },
  });

  useConfigureSuggestions({
    suggestions: [
      { title: 'List campaigns', message: 'list campaigns' },
      { title: 'New campaign', message: 'create campaign Summer launch' },
      { title: 'Draft a campaign', message: 'draft campaign for founders launching a new AI newsletter' },
      { title: 'What can you do?', message: 'help' },
    ],
    available: 'always',
  });

  return (
    <CopilotKitSidebar
      agentId="default"
      defaultOpen={false}
      labels={{
        modalHeaderTitle: 'Marketing assistant',
        chatInputPlaceholder: 'Ask about campaigns, audiences, channels…',
        welcomeMessageText: 'Hi. Try "list campaigns" or ask me to draft one.',
      }}
    />
  );
}
