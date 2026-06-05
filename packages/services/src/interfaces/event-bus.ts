/**
 * Reverse-RPC broker: emits ordered `Event`s coming out of `KimiCore` to the
 * outside world (daemon → WS clients in P1.x; tests can use a no-op impl in W3).
 *
 * The broker is the receive-end of the in-process RPC bridge: when an agent
 * step emits an event, `HarnessBridge`'s `BridgeClientAPI.emitEvent(event)`
 * forwards it to `IEventBus.publish(event)`. Concrete impls land in W5/Chain N.
 *
 * Decorator name `'IEventBus'` is the diagnostic string surfaced in
 * `CyclicDependencyError.path` and `'No service registered for identifier ...'`
 * messages. Keep it stable across phases.
 */

import { createDecorator } from '@moonshot-ai/agent-core';
import type { Event } from '@moonshot-ai/protocol';

export interface IEventBus {
  /**
   * Publish a fully-formed `Event` to all subscribers. Synchronous; the bridge
   * does not await delivery — fan-out is the broker's concern.
   */
  publish(event: Event): void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IEventBus = createDecorator<IEventBus>('IEventBus');
