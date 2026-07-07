/**
 * Adapt agent-core-v2 `IEventBus` events into the v1 SDK `Event` union so the
 * existing `kimi -p` driver (`run-prompt.ts`) can consume them unchanged.
 *
 * v2 `DomainEvent` payloads are already v1-protocol-shaped by construction
 * (they were ported from the v1 `record.signal(agentEvent)` sites); the v1
 * `Event` type is just `AgentEvent & { agentId; sessionId }`. So adaptation is
 * attaching those two fields plus a couple of v2→v1 type-name remaps. Mirrors
 * `packages/kap-server/src/transport/ws/v1/sessionEventBroadcaster.ts:391-421`.
 */

import type { DomainEvent, IEventBus } from '@moonshot-ai/agent-core-v2';
import type { Event, Unsubscribe } from '@moonshot-ai/kimi-code-sdk';

export function subscribeAgentEvents(
  eventBus: IEventBus,
  sessionId: string,
  agentId: string,
  listener: (event: Event) => void,
): Unsubscribe {
  const disposable = eventBus.subscribe((event: DomainEvent) => {
    listener(adaptEvent(event, sessionId, agentId));
  });
  return () => disposable.dispose();
}

function adaptEvent(event: DomainEvent, sessionId: string, agentId: string): Event {
  // v2 emits `task.started` / `task.terminated`; the v1 protocol stream spells
  // them `background.task.*` (payload shape is identical: `{ info }`). Remap so
  // consumers see a single stream across engines.
  if (event.type === 'task.started') {
    return { ...event, type: 'background.task.started', agentId, sessionId } as unknown as Event;
  }
  if (event.type === 'task.terminated') {
    return { ...event, type: 'background.task.terminated', agentId, sessionId } as unknown as Event;
  }
  return { ...event, agentId, sessionId } as unknown as Event;
}
