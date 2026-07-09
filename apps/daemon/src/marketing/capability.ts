import type {
  AguiCapability,
  AguiCapabilityInput,
  AguiContextItem,
  AguiEvent,
} from '../agui-copilot/types.js';
import { createCampaign, listCampaigns } from './campaigns.js';
import { detectAgents, runChat } from './engine.js';

// The Open Marketing workspace assistant, expressed as a transport-neutral
// agui-copilot capability. It yields neutral AguiEvents only — the adapter
// translates them to ag-ui/CopilotKit. This file imports the port TYPES only
// (erased at compile time), so the marketing domain never depends on
// @copilotkit/@ag-ui at runtime.

interface PageContextSnapshot {
  view?: string;
  engineId?: string | null;
  engineName?: string | null;
  campaigns?: Array<{ id: string; name: string; status: string }>;
}

type AgentCommand =
  | { type: 'help' }
  | { type: 'listCampaigns' }
  | { type: 'createCampaign'; name: string; pendingPrompt: string }
  | { type: 'navigate'; path: string; label: string };

const HELP_TEXT = [
  'Try one of these commands:',
  '',
  '- `list campaigns`',
  '- `create campaign Summer launch`',
  '- `draft campaign for founders launching a new AI newsletter`',
  '',
  'Anything else is sent to the selected local engine from the page context.',
].join('\n');

export function createMarketingCapability(): AguiCapability {
  return {
    async *run(input: AguiCapabilityInput): AsyncGenerator<AguiEvent> {
      const prompt = input.prompt.trim();
      const pageContext = readPageContext(input.context);
      const command = parseCommand(prompt);

      if (command?.type === 'help' || !prompt) {
        yield { type: 'text', text: HELP_TEXT };
      } else if (command?.type === 'listCampaigns') {
        const campaigns = await listCampaigns();
        yield { type: 'tool-result', name: 'listCampaigns', args: {}, result: { campaigns } };
        yield {
          type: 'text',
          text:
            campaigns.length === 0
              ? 'No campaigns yet.'
              : campaigns
                  .slice(0, 8)
                  .map((campaign) => `- ${campaign.name} (${campaign.status})`)
                  .join('\n'),
        };
      } else if (command?.type === 'createCampaign') {
        const campaign = await createCampaign({
          name: command.name,
          pendingPrompt: command.pendingPrompt,
        });
        yield {
          type: 'tool-result',
          name: 'createCampaign',
          args: { name: command.name },
          result: { campaign: { id: campaign.id, name: campaign.name, status: campaign.status } },
        };
        yield {
          type: 'text',
          text: `Created campaign "${campaign.name}" as a ${campaign.status} campaign.`,
        };
      } else if (command?.type === 'navigate') {
        yield { type: 'tool-call', name: 'navigate', args: { path: command.path } };
        yield { type: 'text', text: `Opening ${command.label}.` };
      } else {
        // Engine failures (CLI not installed, signed-out, usage-limited, or a
        // non-zero exit) are expected, user-actionable conditions — not adapter
        // bugs. Catch them here and yield a readable assistant message instead
        // of letting them propagate to `CapabilityAgent.run`, which turns any
        // thrown error into a raw CopilotKit RUN_ERROR banner.
        try {
          const engineId = await resolveEngineId(pageContext);
          const contextBlock = pageContext
            ? `\n\nCurrent page context:\n${JSON.stringify(pageContext, null, 2)}`
            : '';
          const result = await runChat({
            engineId,
            prompt: [
              'You are the assistant inside Open Marketing, an AI-native marketing workspace.',
              'Be concise and practical. When the user asks for app actions, mention the available commands: list campaigns, create campaign <name>, draft campaign <brief>.',
              contextBlock,
              '',
              `User: ${prompt}`,
            ].join('\n'),
          });
          yield { type: 'text', text: result.text };
        } catch (err) {
          yield { type: 'text', text: formatEngineError(err) };
        }
      }

      const campaigns = await listCampaigns();
      yield {
        type: 'state',
        snapshot: {
          view: pageContext?.view ?? 'unknown',
          campaignCount: campaigns.length,
          latestCampaigns: campaigns.slice(0, 5).map((campaign) => ({
            id: campaign.id,
            name: campaign.name,
            status: campaign.status,
          })),
        },
      };
    },
  };
}

// Render an engine failure as a calm, actionable assistant message. The
// engine layer (`engine.ts`) now packs the real cause — the tail of the CLI's
// stdout/stderr — into the error, so `Details:` surfaces e.g. a usage-limit or
// "please run /login" notice that `claude -p` prints to stdout on exit 1.
function formatEngineError(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return [
    '⚠️ The local engine couldn’t complete this turn.',
    '',
    'Common causes: the CLI hit a usage limit, needs to be signed in for the daemon’s environment, or isn’t installed. Running it once in a terminal (for example `claude -p "hi"`) confirms whether it works, then retry here.',
    '',
    `Details: ${detail}`,
  ].join('\n');
}

function parseCommand(prompt: string): AgentCommand | null {
  const text = prompt.trim();
  const lower = text.toLowerCase();
  if (!text || lower === 'help' || lower === '/help') return { type: 'help' };
  if (/^(list|show)\s+(my\s+)?campaigns\b/.test(lower) || lower === 'campaigns') {
    return { type: 'listCampaigns' };
  }

  const navMatch = lower.match(/^(?:go|navigate|open|take me)\s+(?:to\s+)?(?:the\s+)?([a-z]+)(?:\s+page)?$/);
  if (navMatch?.[1]) {
    const target = navTarget(navMatch[1]);
    if (target) return target;
  }

  const createMatch = text.match(/^create\s+(?:a\s+)?campaign(?:\s+(?:called|named))?\s+["']?(.+?)["']?$/i);
  if (createMatch?.[1]) {
    return {
      type: 'createCampaign',
      name: normalizeCampaignName(createMatch[1]),
      pendingPrompt: text,
    };
  }

  const draftMatch = text.match(/^draft\s+(?:a\s+)?campaign\s+(?:for|about)?\s*(.+)$/i);
  if (draftMatch?.[1]) {
    return {
      type: 'createCampaign',
      name: normalizeCampaignName(draftMatch[1]),
      pendingPrompt: text,
    };
  }

  return null;
}

function navTarget(input: string): AgentCommand | null {
  const view = input.replace(/s$/, '');
  const targets: Record<string, { path: string; label: string }> = {
    home: { path: '/home', label: 'Home' },
    campaign: { path: '/campaigns', label: 'Campaigns' },
    audience: { path: '/audiences', label: 'Audiences' },
    channel: { path: '/channels', label: 'Channels' },
    asset: { path: '/assets', label: 'Assets' },
    integration: { path: '/integrations', label: 'Integrations' },
  };
  const target = targets[view];
  return target ? { type: 'navigate', ...target } : null;
}

function normalizeCampaignName(input: string): string {
  const name = input.trim().replace(/^["']|["']$/g, '');
  if (name.length <= 80) return name;
  return name.slice(0, 77).trimEnd() + '...';
}

async function resolveEngineId(pageContext: PageContextSnapshot | null): Promise<string> {
  if (pageContext?.engineId) return pageContext.engineId;
  const agents = await detectAgents();
  const available = agents.find((agent) => agent.available);
  if (!available) {
    throw new Error('No local engine is available. Start the daemon and install Claude, Codex, or another supported CLI.');
  }
  return available.id;
}

function readPageContext(context: AguiContextItem[]): PageContextSnapshot | null {
  const snapshot: PageContextSnapshot = {};
  for (const item of context) {
    if (!item.description.toLowerCase().includes('open marketing')) continue;
    try {
      Object.assign(snapshot, JSON.parse(item.value) as PageContextSnapshot);
    } catch {
      continue;
    }
  }
  return Object.keys(snapshot).length > 0 ? snapshot : null;
}
