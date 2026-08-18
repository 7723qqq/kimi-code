/** @jsxImportSource @opentui/solid */
/**
 * TUI2 context providers.
 * Organizes the app's global dependencies as a SolidJS Context stack, the
 * same pattern opencode's `app.tsx` uses. This file owns the top-level
 * providers that every route/component reads:
 *
 *   - `Tui2StoreProvider` — the response store (`state.tsx`)
 *   - `Tui2EventProvider` — the session event bus (`event.ts`)
 *
 * Theme is intentionally a singleton (`currentTheme` in `theme.ts`), so it
 * needs no provider here — components read it directly.
 *
 * Status: REAL (tui2). New file — no v1 counterpart to re-export.
 */

import { createContext, Show, useContext, type ParentProps } from 'solid-js'

import type { Tui2EventBus } from './event'
import { useTui2Store, Tui2StoreProvider, type Tui2Store } from './state'

const EventCtx = createContext<Tui2EventBus>()

export function Tui2EventProvider(props: ParentProps<{ bus: Tui2EventBus }>) {
  return (
    <Show when={props.bus}>
      <EventCtx.Provider value={props.bus}>{props.children}</EventCtx.Provider>
    </Show>
  )
}

export function useTui2Event(): Tui2EventBus {
  const ctx = useContext(EventCtx)
  if (ctx === undefined) throw new Error('Tui2EventProvider missing')
  return ctx
}

export interface Tui2ProviderStackProps {
  store: Tui2Store
  bus?: Tui2EventBus
}

/**
 * Compose the full provider stack. Order matters: store first (everything
 * reads it), then the event bus.
 */
export function Tui2ProviderStack(props: ParentProps<Tui2ProviderStackProps>) {
  return (
    <Tui2StoreProvider store={props.store}>
      {props.bus === undefined ? (
        props.children
      ) : (
        <Tui2EventProvider bus={props.bus}>{props.children}</Tui2EventProvider>
      )}
    </Tui2StoreProvider>
  )
}

export { useTui2Store }
