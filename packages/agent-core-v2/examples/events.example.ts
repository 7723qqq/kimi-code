/**
 * Scenario: the **event bus** slice — soft coupling through `IEventService`.
 *
 * Concept taught: not every dependency is a constructor injection. When a
 * domain wants to broadcast a fact to an *unknown* set of consumers, it
 * publishes a typed `DomainEvent` to the App-scope `IEventService` instead of
 * importing and calling each consumer. The dep-graph records these as `publish`
 * / `subscribe` / `emit` / `on` edges — softer than `ctor` edges because the
 * publisher holds no reference to its consumers.
 *
 * Real publishers in the graph include `ISessionLifecycleService`,
 * `IModelCatalogService`, and `IOAuthService`; here we use a tiny in-file publisher to isolate the
 * wiring without pulling in those domains.
 *
 * Prerequisites: example 01 (container & scope tree).
 *
 * Run:
 *   pnpm --filter @moonshot-ai/agent-core-v2 example -- examples/events.example.ts
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { type IDisposable } from '#/_base/di';
import { createDecorator } from '#/_base/di/instantiation';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost } from '#/_base/di/test';

import {
  type DomainEvent,
  EventService,
  IEventService,
} from '#/app/event';

interface IPublisher {
  announce(kind: string, detail: string): void;
}

/** An Agent-scope publisher that broadcasts through the App-scope bus. */
class Publisher implements IPublisher {
  constructor(@IEventService private readonly events: IEventService) {}
  announce(kind: string, detail: string): void {
    this.events.publish({ type: kind, payload: { detail } });
  }
}

const IPublisher = createDecorator<IPublisher>('ex-events-publisher');

describe('events slice (soft coupling via IEventService)', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(LifecycleScope.App, IEventService, EventService, undefined, 'event');
    registerScopedService(LifecycleScope.Agent, IPublisher, Publisher);
  });

  it('delivers a published DomainEvent to a subscriber', () => {
    const host = createScopedTestHost();
    const bus = host.app.accessor.get(IEventService);

    const received: DomainEvent[] = [];
    const sub = bus.subscribe((e) => received.push(e));

    bus.publish({ type: 'session.archived', payload: { sessionId: 's1' } });

    expect(received).toEqual([
      { type: 'session.archived', payload: { sessionId: 's1' } },
    ]);

    sub.dispose();
    host.dispose();
  });

  it('decouples an Agent-scope publisher from its consumers', () => {
    const host = createScopedTestHost();
    const session = host.child(LifecycleScope.Session, 's1');
    const agent = host.childOf(session, LifecycleScope.Agent, 'main');

    // The consumer subscribes through the same App-scope bus the publisher
    // resolves upward to — neither side imports the other.
    const received: DomainEvent[] = [];
    host.app.accessor.get(IEventService).subscribe((e) => received.push(e));

    agent.accessor.get(IPublisher).announce('turn.completed', 'turn-42');

    expect(received).toEqual([
      { type: 'turn.completed', payload: { detail: 'turn-42' } },
    ]);

    host.dispose();
  });

  it('stops delivering after the subscription is disposed', () => {
    const host = createScopedTestHost();
    const bus = host.app.accessor.get(IEventService);

    const received: DomainEvent[] = [];
    const sub: IDisposable = bus.subscribe((e) => received.push(e));

    bus.publish({ type: 'first', payload: null });
    sub.dispose();
    bus.publish({ type: 'second', payload: null });

    expect(received.map((e) => e.type)).toEqual(['first']);

    host.dispose();
  });
});
