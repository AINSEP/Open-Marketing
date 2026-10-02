import { useEffect, useRef, useState } from 'react';
import type { AgentEvent, ChatMessage } from '../../types';
import { streamViaDaemon } from '../../providers/daemon';
import { fetchAgents } from '../../providers/registry';
import { createProject, getProject } from '../../state/projects';
import { navigate as routerNavigate, type Route } from '../../router';
import { NAV_TARGETS, navInstruction, parseNavCommand } from './nav-tools';
import styles from './OMChatPane.module.css';

// OMChatPane — a purpose-built, app-GLOBAL assistant surface.
//
// Mounted next to CopilotSidebar in App.tsx (OUTSIDE the route switch), so it —
// and its run/SSE consumer — survive every navigation. That is what lets one
// chat drive the whole app, which the project-scoped native ChatPane cannot.
//
//   Stage 1: global surface (FAB + panel + composer).           [done]
//   Stage 2: run the daemon agent via streamViaDaemon against a  [this file]
//            hidden "assistant" shadow project.
//   Stage 3: navigate tool — the agent runs the `app-control     [this file]
//            navigate` wrapper via Bash; we observe the tool_use
//            and call router.navigate. Targets come from a data
//            registry (nav-tools.ts), never hardcoded branches.

interface OMMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

let messageSeq = 0;
function nextId(): string {
  messageSeq += 1;
  return `om-${Date.now()}-${messageSeq}`;
}

const SHADOW_PROJECT_STORAGE_KEY = 'om.assistant.projectId';

// Resolve (and cache) the daemon agent to run the assistant with. Picks the
// first available detected agent; falls back to the first agent so a run can at
// least surface a clear "not available" error rather than silently no-op.
let cachedAgentId: string | null = null;
async function ensureAgentId(): Promise<string | null> {
  if (cachedAgentId) return cachedAgentId;
  const agents = await fetchAgents();
  const pick = agents.find((a) => a.available) ?? agents[0];
  cachedAgentId = pick?.id ?? null;
  return cachedAgentId;
}

// The "shadow assistant chat": one hidden managed project that gives the global
// assistant a stable cwd (the daemon run engine wants a project). Never shown in
// the project list; resolved once and remembered across sessions.
let shadowProject: { projectId: string; conversationId: string } | null = null;
async function ensureShadowProject(): Promise<{ projectId: string; conversationId: string }> {
  if (shadowProject) return shadowProject;

  const savedId = localStorage.getItem(SHADOW_PROJECT_STORAGE_KEY);
  if (savedId) {
    const existing = await getProject(savedId);
    if (existing) {
      // Conversation id is only needed to route the run to a specific thread;
      // omitting it lets the daemon pick the project's default conversation.
      shadowProject = { projectId: savedId, conversationId: '' };
      return shadowProject;
    }
  }

  const created = await createProject({
    name: 'Assistant',
    skillId: null,
    designSystemId: null,
  });
  localStorage.setItem(SHADOW_PROJECT_STORAGE_KEY, created.project.id);
  shadowProject = { projectId: created.project.id, conversationId: created.conversationId };
  return shadowProject;
}

export function OMChatPane(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<OMMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  // Append streamed text to the in-flight assistant message (by id).
  function appendToAssistant(id: string, chunk: string) {
    setMessages((curr) =>
      curr.map((m) => (m.id === id ? { ...m, text: m.text + chunk } : m)),
    );
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setBusy(true);

    const userMsg: OMMessage = { id: nextId(), role: 'user', text };
    const assistantId = nextId();
    // Snapshot prior turns BEFORE adding the new ones (for the daemon history).
    const priorTurns = messages;
    setMessages((curr) => [...curr, userMsg, { id: assistantId, role: 'assistant', text: '' }]);

    try {
      const agentId = await ensureAgentId();
      if (!agentId) {
        appendToAssistant(assistantId, '⚠️ No agent is available. Start the daemon and install a CLI agent.');
        return;
      }
      const { projectId, conversationId } = await ensureShadowProject();

      // Build the daemon history. The final user turn carries a compact
      // app-control instruction so the agent knows it can navigate — kept out
      // of the visible bubble.
      const history: ChatMessage[] = [
        ...priorTurns.map((m) => ({ id: m.id, role: m.role, content: m.text })),
        { id: userMsg.id, role: 'user', content: `${navInstruction()}\n\n${text}` },
      ];

      const controller = new AbortController();
      abortRef.current = controller;

      await streamViaDaemon({
        agentId,
        projectId,
        conversationId: conversationId || undefined,
        history,
        signal: controller.signal,
        handlers: {
          onDelta: (chunk) => appendToAssistant(assistantId, chunk),
          onAgentEvent: (ev: AgentEvent) => {
            const target = navTargetFromEvent(ev);
            if (target) routerNavigate(target);
          },
          onError: (err) => appendToAssistant(assistantId, `\n\n⚠️ ${err.message}`),
          onDone: () => {
            /* text already streamed via onDelta */
          },
        },
      });
    } catch (err) {
      appendToAssistant(assistantId, `\n\n⚠️ ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={styles.fab}
        aria-label={open ? 'Close assistant' : 'Open assistant'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '×' : 'OM'}
      </button>

      <section
        className={`${styles.panel} ${open ? styles.panelOpen : ''}`}
        aria-hidden={!open}
        role="dialog"
        aria-label="Open Marketing assistant"
      >
        <header className={styles.header}>
          <span className={styles.title}>Assistant</span>
          <button
            type="button"
            className={styles.headerClose}
            aria-label="Close assistant"
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </header>

        <div className={styles.log} ref={logRef}>
          {messages.length === 0 ? (
            <p className={styles.empty}>
              Ask me to move around the app — e.g. “take me to design systems”.
            </p>
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                className={`${styles.msg} ${m.role === 'user' ? styles.msgUser : styles.msgAssistant}`}
              >
                {m.text || (m.role === 'assistant' && busy ? '…' : '')}
              </div>
            ))
          )}
        </div>

        <div className={styles.composer}>
          <textarea
            className={styles.input}
            value={input}
            placeholder="Message the assistant…"
            rows={2}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
          />
          <button
            type="button"
            className={styles.send}
            disabled={!input.trim() || busy}
            onClick={() => void handleSend()}
          >
            Send
          </button>
        </div>
      </section>
    </>
  );
}

// Stage 3 signal: the agent navigates by running the app-control wrapper via its
// Bash tool. We recognize that tool_use, map the target through the data
// registry, and execute the navigation client-side (the tool itself is a no-op
// server-side — this is a `surface:'frontend'` action).
function navTargetFromEvent(ev: AgentEvent): Route | null {
  if (ev.kind !== 'tool_use') return null;
  const input = ev.input as Record<string, unknown> | null | undefined;
  const command =
    ev.name === 'Bash' && input && typeof input.command === 'string' ? input.command : '';
  // Also accept a direct structured tool call named `navigate` (future MCP path).
  const directTarget =
    ev.name === 'navigate' && input && typeof input.target === 'string' ? input.target : null;
  const targetId = directTarget ?? parseNavCommand(command);
  if (!targetId) return null;
  return NAV_TARGETS[targetId] ?? null;
}
