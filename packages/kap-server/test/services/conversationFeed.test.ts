import {
  IAgentContextMemoryService,
  IAgentLoopService,
  IEventBus,
  IEventDispatcher,
  ILogService,
  TurnEnded,
  TurnPrompt,
  TurnStepInterrupted,
  type ContextMessage,
  type IAgentScopeHandle,
} from '@moonshot-ai/agent-core-v2';
import type { Event2 } from '@moonshot-ai/agent-core-v2/app/event/event2';
import { describe, expect, it } from 'bun:test';

import { ConversationFeed, type ConversationEvent } from '../../src/services/conversation/conversationFeed';

class FakeBus {
  declare readonly _serviceBrand: undefined;
  private readonly listeners = new Set<(event: Event2) => void>();

  emit(event: Event2): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  subscribe(
    arg: ((event: Event2) => void) | (new (...args: never[]) => Event2),
    handler?: (event: Event2) => void,
  ): { dispose(): void } {
    const listener = handler === undefined
      ? (arg as (event: Event2) => void)
      : (event: Event2): void => {
          if (event instanceof (arg as new (...args: never[]) => Event2)) handler(event);
        };
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  publish(): void {}

  subscribeAgent(): { dispose(): void } {
    return { dispose: () => {} };
  }
}

interface Harness {
  bus: FakeBus;
  feed: ConversationFeed;
  events: ConversationEvent[];
  setMessages(messages: readonly ContextMessage[]): void;
  setRunning(activeTurnId: number | undefined): void;
}

async function harness(messages: readonly ContextMessage[]): Promise<Harness> {
  const bus = new FakeBus();
  let current = [...messages];
  let loop: { state: 'idle' | 'running'; activeTurnId?: number } = { state: 'idle' };
  const services = new Map<unknown, unknown>([
    [IEventBus, bus],
    [IAgentContextMemoryService, { get: () => current }],
    [IAgentLoopService, { snapshot: () => loop }],
    [IEventDispatcher, { whenRestored: () => Promise.resolve() }],
    [ILogService, { warn: () => {} }],
  ]);
  const handle = {
    id: 'main',
    accessor: {
      get: (token: unknown) => {
        const service = services.get(token);
        if (service === undefined) throw new Error('unexpected service');
        return service;
      },
    },
  } as unknown as IAgentScopeHandle;
  const feed = new ConversationFeed(handle);
  await feed.ready;
  const events: ConversationEvent[] = [];
  feed.subscribe((event) => events.push(event));
  return {
    bus,
    feed,
    events,
    setMessages: (next) => {
      current = [...next];
    },
    setRunning: (activeTurnId) => {
      loop = activeTurnId === undefined ? { state: 'idle' } : { state: 'running', activeTurnId };
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const userMessage = (id: string, text: string): ContextMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
  toolCalls: [],
  id,
  origin: { kind: 'user' },
});

const assistantWithCalls = (calls: readonly { id: string; name: string }[]): ContextMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text: 'run them' }],
  toolCalls: calls.map((call) => ({ type: 'function', id: call.id, name: call.name, arguments: '{}' })),
});

const toolResult = (toolCallId: string, text: string, isError?: boolean): ContextMessage => ({
  role: 'tool',
  content: [{ type: 'text', text }],
  toolCalls: [],
  toolCallId,
  isError,
});

function toolCallOf(feed: ConversationFeed, toolCallId: string) {
  const item = feed.turns().flatMap((turn) => turn.items).find((candidate) => candidate.item_id === toolCallId);
  if (item?.type !== 'tool_call') throw new Error(`no tool call ${toolCallId}`);
  return item;
}

describe('conversation feed interruption', () => {
  it('marks the tool calls a stop cuts short as interrupted on the live path', async () => {
    const opener = userMessage('u1', 'run them');
    const assistant = assistantWithCalls([
      { id: 'Read_0', name: 'Read' },
      { id: 'Read_1', name: 'Read' },
      { id: 'Bash_2', name: 'Bash' },
    ]);
    const read = toolResult('Read_0', 'file body');
    const failed = toolResult('Read_1', 'file not found', true);
    const test = await harness([opener, assistant, read, failed]);

    test.setRunning(1);
    test.bus.emit(new TurnPrompt({ agentId: 'main', input: [], origin: { kind: 'user' }, promptId: 'u1', turnId: 1 }));
    await tick();

    expect(test.feed.turns()).toHaveLength(1);
    expect(test.feed.turns()[0]).toMatchObject({ status: 'running', turn_number: 1 });
    expect(toolCallOf(test.feed, 'Read_0')).toMatchObject({ outcome: 'completed', output: 'file body' });
    expect(toolCallOf(test.feed, 'Read_1')).toMatchObject({ outcome: 'failed', error: 'file not found' });
    expect(toolCallOf(test.feed, 'Bash_2')).toMatchObject({ status: 'running' });

    test.setMessages([opener, assistant, read, failed, toolResult('Bash_2', 'Interrupted by user', true)]);
    test.bus.emit(new TurnStepInterrupted({ agentId: 'main', turnId: 1, step: 1, stepId: 's1', reason: 'aborted' }));
    test.setRunning(undefined);
    test.bus.emit(new TurnEnded({ agentId: 'main', turnId: 1, reason: 'cancelled' }));
    await tick();

    const [turn] = test.feed.turns();
    expect(turn).toMatchObject({ status: 'ended', outcome: 'interrupted' });
    expect(toolCallOf(test.feed, 'Read_0')).toMatchObject({ outcome: 'completed', output: 'file body' });
    expect(toolCallOf(test.feed, 'Read_1')).toMatchObject({ outcome: 'failed', error: 'file not found' });
    const stopped = toolCallOf(test.feed, 'Bash_2');
    expect(stopped).toMatchObject({ status: 'ended', outcome: 'interrupted', error: 'Interrupted by user' });
    expect(stopped).not.toHaveProperty('output', expect.anything());

    const ended = test.events.findLast((event) => event.type === 'item.ended' && event.item.item_id === 'Bash_2');
    expect(ended).toMatchObject({ item: { type: 'tool_call', outcome: 'interrupted' } });
    test.feed.dispose();
  });

  it('keeps a tool error failed when the step failed instead of being stopped', async () => {
    const opener = userMessage('u1', 'run it');
    const assistant = assistantWithCalls([{ id: 'Bash_0', name: 'Bash' }]);
    const test = await harness([opener, assistant]);

    test.setRunning(1);
    test.bus.emit(new TurnPrompt({ agentId: 'main', input: [], origin: { kind: 'user' }, promptId: 'u1', turnId: 1 }));
    await tick();

    test.setMessages([opener, assistant, toolResult('Bash_0', 'Tool "Bash" was aborted', true)]);
    test.bus.emit(new TurnStepInterrupted({ agentId: 'main', turnId: 1, step: 1, stepId: 's1', reason: 'error' }));
    test.setRunning(undefined);
    test.bus.emit(new TurnEnded({ agentId: 'main', turnId: 1, reason: 'failed' }));
    await tick();

    expect(toolCallOf(test.feed, 'Bash_0')).toMatchObject({ outcome: 'failed', error: 'Tool "Bash" was aborted' });
    test.feed.dispose();
  });
});
