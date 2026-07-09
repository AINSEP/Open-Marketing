import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type Message,
  type RunAgentInput,
} from '@ag-ui/client';
import { Observable } from 'rxjs';

import type { AguiCapability, AguiCapabilityInput } from '../types.js';
import { emitText, emitToolCall, emitToolResult } from './events.js';

// Generic adapter: wraps any transport-neutral AguiCapability as an ag-ui
// AbstractAgent. This is the ONLY bridge between the neutral capability port
// and the ag-ui protocol — domain capabilities never touch ag-ui directly.
export class CapabilityAgent extends AbstractAgent {
  constructor(
    id: string,
    description: string,
    private capability: AguiCapability,
  ) {
    super({ agentId: id, description });
  }

  // ag-ui's AbstractAgent.clone() builds the copy with
  // Object.create(prototype) and copies only its own fixed field set — it
  // never calls the constructor, so our `capability` would be dropped.
  // CopilotKit clones the registered agent per run, which would then hit
  // `this.capability` === undefined. Carry it across explicitly.
  override clone(): this {
    const cloned = super.clone() as this;
    cloned.capability = this.capability;
    return cloned;
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((observer) => {
      void this.pump(input, observer).catch((err: unknown) => {
        observer.next({
          type: EventType.RUN_ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        observer.complete();
      });
    });
  }

  private async pump(
    input: RunAgentInput,
    observer: { next: (event: BaseEvent) => void; complete: () => void },
  ): Promise<void> {
    observer.next({
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
    });

    for await (const event of this.capability.run(toCapabilityInput(input))) {
      switch (event.type) {
        case 'text':
          emitText(observer, event.text);
          break;
        case 'tool-call':
          emitToolCall(observer, event.name, event.args);
          break;
        case 'tool-result':
          emitToolResult(observer, event.name, event.args, event.result);
          break;
        case 'state':
          observer.next({ type: EventType.STATE_SNAPSHOT, snapshot: event.snapshot });
          break;
      }
    }

    observer.next({
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
      outcome: { type: 'success' },
    });
    observer.complete();
  }
}

function toCapabilityInput(input: RunAgentInput): AguiCapabilityInput {
  return {
    prompt: latestUserText(input.messages),
    threadId: input.threadId,
    runId: input.runId,
    context: (input.context ?? []).map((item) => ({
      description: item.description,
      value: item.value,
    })),
    messages: input.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  };
}

function latestUserText(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') return contentToText(message.content);
  }
  return '';
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part) {
        return typeof part.text === 'string' ? part.text : '';
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}
