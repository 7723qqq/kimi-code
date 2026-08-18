/** @jsxImportSource @opentui/solid */
/**
 * TUI2 response state core.
 *
 * This is the opentui + SolidJS replacement for the v1 pi-tui `TUIState`
 * (a command tree of Containers). It holds the whole interactive view model
 * in a single SolidJS store (`createStore`) and exposes it to components via
 * a Context provider — the same architecture opencode uses for its TUI.
 *
 * The store is the single source of truth: event adapters (`event.ts`) and
 * command handlers mutate it with `produce` / `reconcile`, and the opentui
 * reconciler re-renders whatever subscribes to the changed slice. There is
 * no `requestRender()` / `addChild()` imperative plumbing — components react
 * to store slices automatically.
 *
 * Status: REAL (tui2). New file — no v1 counterpart to re-export.
 */

import { createContext, Show, useContext, type ParentProps } from 'solid-js'
import { createStore, produce, reconcile, type SetStoreFunction } from 'solid-js/store'

import type { PermissionMode, ThinkingEffort } from '@moonshot-ai/kimi-code-sdk'

import type { PendingApproval, PendingQuestion } from './reverse-rpc/types'
import type { LivePaneMode, TranscriptEntry } from './types'

/** A turn's streaming buffers, keyed by turnId. */
export interface TurnStream {
  /** Accumulated assistant text from `assistant.delta`. */
  assistantText: string
  /** Accumulated thinking text from `thinking.delta`. */
  thinkingText: string
  /** Tool calls keyed by toolCallId, live arguments merged from `tool.call.delta`. */
  toolCalls: Record<string, StreamToolCall>
}

export interface StreamToolCall {
  id: string
  name?: string
  /** Accumulated partial JSON arguments. */
  argumentsText: string
  finished?: boolean
}

export interface TuiRuntimeState {
  /** Current session id (empty until a session exists). */
  sessionId: string
  /** Working directory mirrored from startup. */
  workDir: string
  model: string
  permissionMode: PermissionMode
  planMode: boolean
  thinkingEffort: ThinkingEffort
  inputMode: 'prompt' | 'bash'
  swarmMode: boolean
  streamingPhase: 'idle' | 'waiting' | 'thinking' | 'composing' | 'shell'
  /** Transcript entries in display order. */
  transcript: TranscriptEntry[]
  /** Live streaming buffers for the active turn. */
  streams: Record<string, TurnStream>
  /** Live activity-pane mode + pending reverse-RPC modals. */
  livePane: {
    mode: LivePaneMode
    pendingApproval: PendingApproval | null
    pendingQuestion: PendingQuestion | null
    activityPaneVisible: boolean
  }
  /** Queued messages waiting for the current turn to end. */
  queuedMessages: readonly string[]
  /** Sorted list of sessions for the picker. */
  sessions: readonly { id: string; title: string; updatedAt: number }[]
  loadingSessions: boolean
  /** Session title (footer). */
  sessionTitle: string | null
}

export const INITIAL_RUNTIME: TuiRuntimeState = {
  sessionId: '',
  workDir: '',
  model: '',
  permissionMode: 'manual',
  planMode: false,
  thinkingEffort: 'off',
  inputMode: 'prompt',
  swarmMode: false,
  streamingPhase: 'idle',
  transcript: [],
  streams: {},
  livePane: {
    mode: 'idle',
    pendingApproval: null,
    pendingQuestion: null,
    activityPaneVisible: true,
  },
  queuedMessages: [],
  sessions: [],
  loadingSessions: false,
  sessionTitle: null,
}

export interface Tui2Store {
  readonly state: TuiRuntimeState
  readonly setState: SetStoreFunction<TuiRuntimeState>
}

export function createTui2Store(input?: { workDir?: string }): Tui2Store {
  const [state, setState] = createStore<TuiRuntimeState>({
    ...INITIAL_RUNTIME,
    workDir: input?.workDir ?? process.cwd(),
  })
  return { state, setState }
}

const Ctx = createContext<Tui2Store>()

export function Tui2StoreProvider(props: ParentProps<{ store: Tui2Store }>) {
  return (
    <Show when={props.store}>
      <Ctx.Provider value={props.store}>{props.children}</Ctx.Provider>
    </Show>
  )
}

export function useTui2Store(): Tui2Store {
  const ctx = useContext(Ctx)
  if (ctx === undefined) throw new Error('Tui2StoreProvider missing')
  return ctx
}

export { produce, reconcile }
