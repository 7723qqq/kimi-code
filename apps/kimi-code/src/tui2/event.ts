/**
 * TUI2 event adapter — kimi session events → response store.
 *
 * Mirrors the role of v1's `streaming-ui.ts` + `session-event-handler.ts`,
 * but declarative: subscribe to a `Session`'s `onEvent` stream and mutate the
 * response store with `produce`/`reconcile`. The opentui reconciler then
 * re-renders whatever subscribes to the changed slice — no imperative
 * `addChild` / `requestRender`.
 *
 * This is the same architecture opencode uses (`context/event.ts` +
 * `context/sync.tsx`): a typed `on(type, handler)` subscription that reduces
 * each event into store updates.
 *
 * Status: REAL (tui2). New file — no v1 counterpart to re-export.
 */

import { batch } from 'solid-js'

import type { Event, Session } from '@moonshot-ai/kimi-code-sdk'

export type EventHandler<T extends Event['type']> = (
  event: Extract<Event, { type: T }>,
) => void

export interface Tui2EventBus {
  /** Subscribe to all events. Returns an unsubscribe function. */
  subscribe(handler: (event: Event) => void): () => void
  /** Type-narrowed subscription. */
  on<T extends Event['type']>(type: T, handler: EventHandler<T>): () => void
  /** Unsubscribe from the underlying session and clear all handlers. */
  dispose(): void
}

/**
 * Create an event bus over a kimi `Session`.
 *
 * The returned bus normalizes the SDK `onEvent` stream into a type-safe
 * `on(type, handler)` API and wraps all handlers in `batch()` so a burst of
 * events commits as one store transaction.
 */
export function createEventBus(session: Session): Tui2EventBus {
  const subscriptions = new Map<Event['type'] | '*', Set<(event: Event) => void>>()

  const dispatch = (event: Event): void => {
    batch(() => {
      for (const handler of subscriptions.get('*') ?? []) handler(event)
      for (const handler of subscriptions.get(event.type) ?? []) handler(event)
    })
  }

  const unsubscribe = session.onEvent(dispatch)

  return {
    on<T extends Event['type']>(type: T, handler: EventHandler<T>): () => void {
      let set = subscriptions.get(type)
      if (set === undefined) {
        set = new Set()
        subscriptions.set(type, set)
      }
      const fn = handler as (event: Event) => void
      set.add(fn)
      return () => set?.delete(fn)
    },
    subscribe(handler: (event: Event) => void): () => void {
      let set = subscriptions.get('*')
      if (set === undefined) {
        set = new Set()
        subscriptions.set('*', set)
      }
      set.add(handler)
      return () => set?.delete(handler)
    },
    dispose() {
      unsubscribe()
      subscriptions.clear()
    },
  }
}
