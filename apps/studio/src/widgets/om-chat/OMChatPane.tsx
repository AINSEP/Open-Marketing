import { ChatPane } from '@jini-ai/chat/react/chat-pane';
import { ChatSettingsDialog, JiniChatProvider } from '@jini-ai/chat/react';
import { RemixIcon, PopoverItem, PopoverMenu } from '@jini-ai/ui';
import '@jini-ai/ui/settings-dialog.css';
import './chat.css';
import { chatPermissions, useOMChatPane, usePluginOMChatPane } from './OMChatPane.hooks.js';
import type { OMChatPaneProps, OMChatPaneModel } from './OMChatPane.hooks.js';
import { ChatFab } from './ChatFab.js';
import { serverPickerI18n } from './runtime.rules.js';

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
      <JiniChatProvider transport={props.session.transport} extEventRendererRegistry={chat.registry} i18n={serverPickerI18n}>
        <ChatPane key={chat.state.transcriptVersion} {...chat.pane}
          header={<ChatHeader props={props} chat={chat} />}
          leadingAccessory={<SelectedPlugins chat={chat} />}
          footer={<div className="om-chat-status" role="status">{chat.modeText && <span>{chat.modeText}</span>}{chat.navigationText && <p>{chat.navigationText}</p>}{chat.state.status === 'unavailable' && <p>{chat.state.notice}</p>}</div>} />
        <ChatSettingsDialog open={chat.settings.open} onClose={chat.settings.close} displaySections={chat.displaySections} permissions={chatPermissions} />
      </JiniChatProvider>
    </aside>
  </>;
}
function ChatHeader({ props, chat }: { props: OMChatPaneProps; chat: OMChatPaneModel }) {
  return <header className="jini-chat-pane__header om-chat-header">
    <div className="jini-chat-pane__heading"><h2 className="jini-chat-pane__title" title={chat.title}>{chat.title}</h2></div>
    <button className="om-chat-icon" type="button" onClick={chat.showAgents} disabled={chat.busy} aria-label="Agents" title="Agents and vendors"><RemixIcon name="group-line" size={18} /></button>
    <div className="om-chat-history" ref={chat.history.containerRef}>
      <button className="om-chat-icon" type="button" onClick={chat.history.toggle} disabled={chat.busy} aria-label="Chat history" title="Chat history" aria-haspopup="dialog" aria-expanded={chat.history.open}><RemixIcon name="chat-3-line" size={18} /></button>
      {chat.history.open && <PopoverMenu className="om-chat-history-menu"><div role="dialog" aria-label="Chat history">
        <PopoverItem label="New chat" onClick={chat.history.create} />
        {chat.history.items.map(renderConversation)}
      </div></PopoverMenu>}
    </div>
    <button className="om-chat-icon" type="button" onClick={chat.settings.show} aria-label="Chat settings" title="Chat settings"><RemixIcon name="settings-3-line" size={18} /></button>
    <button className="om-chat-icon" type="button" onClick={props.toggle} aria-label="Close assistant" title="Close assistant"><RemixIcon name="close-line" size={18} /></button>
  </header>;
}
function SelectedPlugins({ chat }: { chat: OMChatPaneModel }) {
  return chat.selectedPlugins.length ? <div className="om-chat-plugins" aria-label="Selected add-ons"><span>Using:</span>{chat.selectedPlugins.map(renderPlugin)}</div> : null;
}
function renderConversation(conversation: OMChatPaneModel['history']['items'][number]) {
  return <PopoverItem key={conversation.id} label={conversation.label} selected={conversation.selected} onClick={conversation.onClick} />;
}
function renderPlugin(plugin: OMChatPaneModel['selectedPlugins'][number]) {
  return <button type="button" key={plugin.id} onClick={plugin.remove} aria-label={'Remove ' + plugin.label}>{plugin.label} ×</button>;
}
