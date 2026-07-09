import { randomUUID } from 'node:crypto';

import { EventType, type BaseEvent } from '@ag-ui/client';

// ag-ui event construction helpers. These are the low-level translation from
// a neutral AguiEvent into the multi-part ag-ui wire events. Confined to the
// agui-copilot adapter layer.

interface EventSink {
  next: (event: BaseEvent) => void;
}

export function emitText(observer: EventSink, text: string): void {
  const messageId = randomUUID();
  observer.next({ type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' });
  observer.next({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text });
  observer.next({ type: EventType.TEXT_MESSAGE_END, messageId });
}

export function emitToolCall(
  observer: EventSink,
  toolCallName: string,
  args: Record<string, unknown>,
): void {
  const toolCallId = randomUUID();
  observer.next({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName });
  observer.next({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(args) });
  observer.next({ type: EventType.TOOL_CALL_END, toolCallId });
}

export function emitToolResult(
  observer: EventSink,
  toolCallName: string,
  args: Record<string, unknown>,
  result: unknown,
): void {
  const toolCallId = randomUUID();
  observer.next({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName });
  observer.next({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(args) });
  observer.next({ type: EventType.TOOL_CALL_END, toolCallId });
  observer.next({
    type: EventType.TOOL_CALL_RESULT,
    messageId: randomUUID(),
    toolCallId,
    content: JSON.stringify(result),
    role: 'tool',
  });
}
