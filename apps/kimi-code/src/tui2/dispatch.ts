/**
 * TUI2 dialog dispatch protocol.
 *
 * The MainShell renders dialogs from `store.state.activeDialog`. Each
 * dialog accepts `onSelect` / `onCancel` (or `onResponse` / `onAnswer` /
 * `onClose`) callbacks. The shell turns those into a single typed
 * `DialogDispatch` so the host (KimiTUI) can route the result without
 * the shell needing to know the host's internals.
 *
 * Usage:
 *
 *   const dispatch: DialogDispatch = hostToDispatch(host)
 *   render(<MainShell dispatch={dispatch} />)
 *
 *   // Inside the shell:
 *   <SessionPicker
 *     sessions={...}
 *     onSelect={(id) => dispatch.select('session-picker', { sessionId: id })}
 *     onCancel={() => dispatch.cancel('session-picker')}
 *   />
 *
 * The protocol is intentionally minimal: `select(kind, result)` for a
 * confirmed choice and `cancel(kind)` for dismissal. The host translates
 * `(kind, result)` into the matching controller / session call.
 *
 * Status: REAL (tui2). New file — no v1 counterpart.
 */

import type { Locale } from '#/i18n'
import type { PermissionMode, ThinkingEffort, ModelAlias } from '@moonshot-ai/kimi-code-sdk'
import type { QuestionSubmissionMethod, QuestionPanelResponse } from './reverse-rpc/types'
import type { ApprovalPanelResponse } from './components/dialogs/approval-panel'
import type { GoalQueueEditResult, GoalQueueManagerAction } from './components/dialogs/goal-queue-manager'
import type { GoalStartPermissionChoice } from './components/dialogs/goal-start-permission-prompt'
import type { QuestionPanelResponse as QDialogResponse } from './components/dialogs/question-dialog'
import type { PluginRemoveConfirmResult } from './components/dialogs/plugins-selector'
import type { PluginInstallTrustConfirmResult } from './components/dialogs/plugins-selector'

/** The full set of dialogs the shell can render. */
export type DialogKind =
  | 'session-picker'
  | 'model-selector'
  | 'plugins-selector'
  | 'theme-selector'
  | 'locale-selector'
  | 'permission-selector'
  | 'editor-selector'
  | 'update-preference'
  | 'msys2-prompt'
  | 'trust-prompt'
  | 'settings-selector'
  | 'cache-hint'
  | 'goal-queue-manager'
  | 'goal-queue-edit'
  | 'goal-start-permission-prompt'
  | 'undo-selector'
  | 'effort-selector'
  | 'help'
  | 'which-key'
  | 'start-permission-prompt'
  | 'swarm-start-permission-prompt'
  | 'approval-panel'
  | 'question-dialog'

/** Discriminated union of every selectable dialog result. */
export type PluginAction =
  | { readonly kind: 'toggle'; readonly id: string; readonly enabled: boolean }
  | { readonly kind: 'remove'; readonly id: string }
  | { readonly kind: 'mcp'; readonly id: string }
  | { readonly kind: 'details'; readonly id: string }
  | { readonly kind: 'reload' }

export type DialogResult =
  | { readonly kind: 'session-picker'; readonly sessionId: string }
  | { readonly kind: 'model-selector'; readonly alias: string; readonly effort: ThinkingEffort }
  | { readonly kind: 'plugins-selector'; readonly action: PluginAction }
  | { readonly kind: 'theme-selector'; readonly themeName: string }
  | { readonly kind: 'locale-selector'; readonly locale: Locale }
  | { readonly kind: 'permission-selector'; readonly mode: PermissionMode }
  | { readonly kind: 'editor-selector'; readonly command: string }
  | { readonly kind: 'update-preference'; readonly enabled: boolean }
  | { readonly kind: 'msys2-prompt'; readonly choice: 'install' | 'skip' }
  | { readonly kind: 'trust-prompt'; readonly choice: 'trust' | 'distrust' }
  | { readonly kind: 'settings-selector'; readonly value: string }
  | { readonly kind: 'cache-hint'; readonly action: 'compact' | 'new' | 'continue' | 'never' }
  | { readonly kind: 'goal-queue-manager'; readonly action: GoalQueueManagerAction }
  | { readonly kind: 'goal-queue-edit'; readonly result: GoalQueueEditResult }
  | {
      readonly kind: 'goal-start-permission-prompt'
      readonly choice: GoalStartPermissionChoice
    }
  | { readonly kind: 'undo-selector'; readonly count: number; readonly input: string }
  | { readonly kind: 'effort-selector'; readonly effort: ThinkingEffort }
  | { readonly kind: 'help' }
  | { readonly kind: 'which-key' }
  | { readonly kind: 'start-permission-prompt'; readonly choice: 'auto' | 'yolo' | 'manual' | 'cancel' }
  | { readonly kind: 'swarm-start-permission-prompt'; readonly choice: 'auto' | 'yolo' | 'manual' }
  | { readonly kind: 'approval-panel'; readonly response: ApprovalPanelResponse }
  | {
      readonly kind: 'question-dialog'
      readonly method?: QuestionSubmissionMethod
      readonly answers: readonly string[]
    }

/**
 * The host-facing side of the dialog protocol. Implementations route
 * `(kind, result)` to the matching controller or session call and
 * dismiss the dialog (`store.setState('activeDialog', null)`).
 */
export interface DialogDispatch {
  select(result: DialogResult): void
  cancel(kind: DialogKind): void
}

/** Convenience helper: the no-op dispatch used in tests / previews. */
export const NOOP_DISPATCH: DialogDispatch = {
  select: () => {},
  cancel: () => {},
}

// Re-export common types so callers don't need to dig through dialog files.
export type { ApprovalPanelResponse, QDialogResponse, QuestionSubmissionMethod, QuestionPanelResponse }
export type { GoalQueueEditResult, GoalQueueManagerAction, GoalStartPermissionChoice }
export type { ModelAlias }

// Re-export plugin-side confirm results (the host uses these when the
// user picks a "remove" / "install" action inside the plugins panel).
export type { PluginRemoveConfirmResult, PluginInstallTrustConfirmResult }
