/**
 * `/api/v2` WS event map — binds a public event name to the scope's `Event`
 * source. Mirrors the `actionMap` (which binds `resource:action` → method); this
 * binds `event` → an `Event` subscription that yields an `IDisposable`.
 *
 * Only the high-value streams are exposed for now:
 *   Core  `events`  — process-wide `DomainEvent` bus (`IEventService`)
 *   Agent `events`  — per-agent `AgentEvent` stream (`IEventSink`)
 */

import {
  IEventService,
  IEventSink,
  type DomainEvent,
  type IDisposable,
  type IScopeHandle,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import type { ScopeKind } from '../channel';

type Accessor = Scope | IScopeHandle;

export interface EventSource {
  subscribe(scope: Accessor, listener: (data: unknown) => void): IDisposable;
}

export const eventMap: Record<ScopeKind, Record<string, EventSource>> = {
  core: {
    events: {
      subscribe: (scope, listener) =>
        scope.accessor.get(IEventService).subscribe(listener as (event: DomainEvent) => void),
    },
  },
  session: {
    // Future: `metadata` (ISessionMetadata.onDidChange), `interactions`
    // (IInteractionService.onDidChange). These carry no payload today, so they
    // are not exposed until there is a concrete consumer.
  },
  agent: {
    events: {
      subscribe: (scope, listener) => scope.accessor.get(IEventSink).on(listener),
    },
  },
};

export function resolveEventSource(scopeKind: ScopeKind, event: string): EventSource | undefined {
  return eventMap[scopeKind][event];
}
