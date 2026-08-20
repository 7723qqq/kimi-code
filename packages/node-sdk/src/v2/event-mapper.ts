/**
 * Domain → wire event translation for the v2 client.
 *
 * The v2 engine emits `Event2`-shaped domain events over `IEventBus`. The v1
 * client surface (`SDKRpcClient.receiveEvent`) consumes a flat `Event` union
 * from `protocol/events.ts`. `translateDomainEvent` maps a single v2 domain
 * event to the v1 wire shape (or returns `undefined` if the event has no
 * client-visible equivalent). `translateGlobalEvent` is the per-listener
 * entry used by the session wiring — it just wraps the per-event call.
 */
import type { Event as ProtocolEvent } from '@moonshot-ai/protocol';

import type { Event } from '#/events';

export function translateDomainEvent(
  event: unknown,
  sessionId: string,
  agentId: string,
): Event | undefined {
  if (event === null || typeof event !== 'object') return undefined;
  const record = event as Record<string, unknown>;
  const type = record['type'];
  if (typeof type !== 'string' || type.length === 0) return undefined;
  return {
    type,
    sessionId,
    agentId,
    payload: stripMetadata(record),
  } as Event;
}

export function translateGlobalEvent(event: unknown): ProtocolEvent | undefined {
  return undefined;
}

function stripMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k === 'type') continue;
    out[k] = v;
  }
  return out;
}
