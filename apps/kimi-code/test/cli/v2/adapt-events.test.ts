import type { DomainEvent, IEventBus } from '@moonshot-ai/agent-core-v2';
import type { Event } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it } from 'vitest';

import { subscribeAgentEvents } from '../../../src/cli/v2/adapt-events';

class MockEventBus {
  private readonly listeners = new Set<(event: DomainEvent) => void>();

  publish(event: DomainEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(handler: (event: DomainEvent) => void): { dispose: () => void } {
    this.listeners.add(handler);
    return {
      dispose: () => {
        this.listeners.delete(handler);
      },
    };
  }
}

function asBus(bus: MockEventBus): IEventBus {
  return bus as unknown as IEventBus;
}

describe('subscribeAgentEvents', () => {
  it('attaches agentId and sessionId to a streaming event', () => {
    const bus = new MockEventBus();
    const received: Event[] = [];
    subscribeAgentEvents(asBus(bus), 'sess-1', 'main', (event) => received.push(event));

    bus.publish({ type: 'assistant.delta', turnId: 1, delta: 'hi' } as DomainEvent);

    expect(received).toEqual([
      { type: 'assistant.delta', turnId: 1, delta: 'hi', agentId: 'main', sessionId: 'sess-1' },
    ]);
  });

  it('passes through turn.ended unchanged apart from agentId/sessionId', () => {
    const bus = new MockEventBus();
    const received: Event[] = [];
    subscribeAgentEvents(asBus(bus), 'sess-2', 'main', (event) => received.push(event));

    bus.publish({ type: 'turn.ended', turnId: 3, reason: 'completed' } as DomainEvent);

    expect(received[0]).toMatchObject({
      type: 'turn.ended',
      turnId: 3,
      reason: 'completed',
      agentId: 'main',
      sessionId: 'sess-2',
    });
  });

  it('remaps task.started to background.task.started', () => {
    const bus = new MockEventBus();
    const received: Event[] = [];
    subscribeAgentEvents(asBus(bus), 's', 'main', (event) => received.push(event));

    bus.publish({ type: 'task.started', info: { taskId: 't1' } } as unknown as DomainEvent);

    expect(received[0]!.type).toBe('background.task.started');
    expect(received[0]!).toMatchObject({ agentId: 'main', sessionId: 's' });
  });

  it('remaps task.terminated to background.task.terminated', () => {
    const bus = new MockEventBus();
    const received: Event[] = [];
    subscribeAgentEvents(asBus(bus), 's', 'main', (event) => received.push(event));

    bus.publish({ type: 'task.terminated', info: { taskId: 't2' } } as unknown as DomainEvent);

    expect(received[0]!.type).toBe('background.task.terminated');
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new MockEventBus();
    const received: Event[] = [];
    const unsubscribe = subscribeAgentEvents(asBus(bus), 's', 'main', (event) =>
      received.push(event),
    );

    bus.publish({ type: 'assistant.delta', turnId: 1, delta: 'a' } as DomainEvent);
    unsubscribe();
    bus.publish({ type: 'assistant.delta', turnId: 1, delta: 'b' } as DomainEvent);

    expect(received).toHaveLength(1);
    expect((received[0] as { delta: string }).delta).toBe('a');
  });
});
