import { ChatPane } from '@jini-ai/chat/react/chat-pane';
import { ChatSettingsDialog, ChatSettingsSegmented, JiniChatProvider } from '@jini-ai/chat/react';
import '@jini-ai/ui/settings-dialog.css';
import './chat.css';
import { chatPermissions, useOMChatPane, usePluginOMChatPane } from './OMChatPane.hooks.js';
import type { OMChatPaneProps, OMChatPaneModel } from './OMChatPane.hooks.js';
import { ChatFab } from './ChatFab.js';

/** Keep the shell's dock/FAB and single session alive across close/reopen and navigation. */
export function OMChatPane(props: OMChatPaneProps) {
  return props.charts ? <PluginChatPane {...props} charts={props.charts} /> : <FallbackChatPane {...props} />;
}
function PluginChatPane(props: OMChatPaneProps & { charts: NonNullable<OMChatPaneProps['charts']> }) {
  const chat = usePluginOMChatPane(props);
  return <ChatPaneView props={props} chat={chat} />;
}
function FallbackChatPane(props: OMChatPaneProps) {
  const chat = useOMChatPane(props);
  return <ChatPaneView props={props} chat={chat} />;
}
function ChatPaneView({ props, chat }: { props: OMChatPaneProps; chat: OMChatPaneModel }) {
  return <>
    <ChatFab buttonRef={chat.buttonRef} open={props.open} toggle={props.toggle} />
    <aside id="om-chat" className="chat-panel om-jini-chat" hidden={!props.open} aria-label="Assistant" tabIndex={-1} ref={chat.panelRef} onKeyDown={chat.keyDown}>
      <JiniChatProvider transport={props.session.transport} extEventRendererRegistry={chat.registry}>
        <ChatPane key={chat.state.transcriptVersion} {...chat.pane}
          header={<ChatHeader props={props} chat={chat} />}
          leadingAccessory={<SelectedPlugins chat={chat} />}
          composerSlots={{ ...chat.pane.composerSlots, footerLeadingAccessory: <ChatSettingsSegmented name="Reasoning effort" items={chat.effortChoices} /> }}
          footer={<div className="om-chat-status" role="status"><span>{chat.state.notice}</span>{chat.navigationText && <p>{chat.navigationText}</p>}<small>Image attachments, vendor/effort selection and cost totals coming soon.</small></div>} />
        <ChatSettingsDialog open={chat.settings.open} onClose={chat.settings.close} displaySections={chat.displaySections} permissions={chatPermissions} />
      </JiniChatProvider>
    </aside>
  </>;
}
function ChatHeader({ props, chat }: { props: OMChatPaneProps; chat: OMChatPaneModel }) {
  return <header className="om-chat-header">
    <strong>Open Marketing assistant</strong>
    <button type="button" onClick={chat.newChat} disabled={chat.busy} aria-label="New chat">＋</button>
    <button type="button" onClick={chat.settings.show} aria-label="Chat settings">⚙</button>
    <button type="button" onClick={props.toggle} aria-label="Close assistant">×</button>
    <label>Recent chats <select aria-label="Recent chats" value={chat.state.conversationId ?? ''} onChange={chat.conversationChanged} disabled={chat.busy}>
      <option value="">New chat</option>{chat.state.conversations.map(renderConversation)}
    </select></label>
    <small>{chat.modeText}</small>
  </header>;
}
function SelectedPlugins({ chat }: { chat: OMChatPaneModel }) {
  return chat.selectedPlugins.length ? <div className="om-chat-plugins" aria-label="Selected add-ons">{chat.selectedPlugins.map(renderPlugin)}</div> : null;
}
function renderConversation(conversation: { conversationId: string; title: string }) {
  return <option key={conversation.conversationId} value={conversation.conversationId}>{conversation.title}</option>;
}
function renderPlugin(plugin: OMChatPaneModel['selectedPlugins'][number]) {
  return <button type="button" key={plugin.id} onClick={plugin.remove} aria-label={'Remove ' + plugin.label}>{plugin.label} ×</button>;
}
