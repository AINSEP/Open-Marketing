import { useState } from 'react';
import type { ChatPaneAgentSelection } from '@jini-ai/chat/react/chat-pane';
import type { ChatState, ChatSession } from '../../features/chat-run/index.js';
import { pickerAgents, pickerSelection, runtimeChoice, runtimeInventory, runtimeReadiness } from './runtime.rules.js';

/** Controlled Jini selections; preview changes stay local, real changes use the session's server write.
 * @complexity O(r*m), bounded by the validated catalogue. No vendor/network effect in preview.
 */
export function useOMChatRuntime(required: { sample: boolean; state: ChatState; session: ChatSession; busy: boolean }) {
  const runtimes = runtimeInventory({ sample: required.sample, settings: required.state.settings });
  const [previewSelection, setPreviewSelection] = useState<ChatPaneAgentSelection>(() => pickerSelection({ settings: null, runtimes }));
  const selection = required.sample ? previewSelection : pickerSelection({ settings: required.state.settings, runtimes });
  const change = (next: ChatPaneAgentSelection): void => {
    if (required.busy) return;
    const choice = runtimeChoice({ selection: next, runtimes });
    if (!choice) return;
    if (required.sample) { setPreviewSelection({ ...next, reasoning: choice.effort }); return; }
    void required.session.selectRuntime(choice);
  };
  const choice = runtimeChoice({ selection, runtimes });
  const selected = runtimes.find(runtime => runtime.id === choice?.provider);
  return { agents: pickerAgents({ runtimes, selection }), selection, change,
    ...runtimeReadiness({ sample: required.sample, status: required.state.settings, selected, choice }) };
}
