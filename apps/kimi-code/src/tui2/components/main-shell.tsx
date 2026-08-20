/** @jsxImportSource @opentui/solid */
/**
 * TUI2 MainShell — the full interactive shell view.
 *
 * Renders the editor + transcript + active dialog + footer + side panes
 * (queue, btw, agent, activity, help, etc.) from `store.state`. The
 * opentui reconciler drives re-renders on every store mutation; the
 * host (KimiTUI) is responsible for routing key events through the
 * keymap and for handling app-level commands (Ctrl+G, Ctrl+O, etc.).
 *
 * Dialog results are routed back to the host through the `dispatch`
 * prop (a `DialogDispatch`). The shell never calls into the host
 * directly — it only knows the dialog kind + the result payload. The
 * host translates those into the matching controller call and dismisses
 * the dialog by setting `store.state.activeDialog` to `null`.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ Banner                                                  │
 *   ├──────────────────────────────┬──────────────────────────┤
 *   │ Transcript (left column)      │ Panes (right column)     │
 *   ├──────────────────────────────┴──────────────────────────┤
 *   │ Active dialog (mounted when activeDialog is set)         │
 *   ├─────────────────────────────────────────────────────────┤
 *   │ Editor                                                   │
 *   ├─────────────────────────────────────────────────────────┤
 *   │ Footer                                                  │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Status: REAL (tui2). Top-level shell view.
 */

import type { Component } from 'solid-js'
import { createSignal, For, Show } from 'solid-js'

import { useTui2Store } from '../context'
import type { DialogDispatch, DialogKind, DialogResult } from '../dispatch'
import type { TranscriptEntry } from '../types'

import { Banner } from './chrome/banner'
import { Footer } from './chrome/footer'
import { QueuePane } from './panes/queue-pane'
import { AgentPane } from './panes/agent-pane'
import { ActivityPane } from './panes/activity-pane'
import { BtwPanel } from './panes/btw-panel'
import { DiffReviewPane } from './panes/diff-review-pane'
import { CustomEditor } from './editor/custom-editor'

import { AssistantMessageView } from './messages/assistant-message'
import { UserMessageView } from './messages/user-message'
import { ThinkingView } from './messages/thinking'
import { PlanBox } from './messages/plan-box'
import { GoalPanel } from './messages/goal-panel'
import { StatusMessageView } from './messages/status-message'

import { ApprovalPanel } from './dialogs/approval-panel'
import { QuestionDialog } from './dialogs/question-dialog'
import { ThemeSelector } from './dialogs/theme-selector'
import { LocaleSelector } from './dialogs/locale-selector'
import { PermissionSelector } from './dialogs/permission-selector'
import { EditorSelector } from './dialogs/editor-selector'
import { UpdatePreferenceSelector } from './dialogs/update-preference-selector'
import { Msys2Prompt } from './dialogs/msys2-prompt'
import { TrustPrompt } from './dialogs/trust-prompt'
import { SettingsSelector } from './dialogs/settings-selector'
import { CacheHintDialog } from './dialogs/cache-hint-dialog'
import { SessionPicker } from './dialogs/session-picker'
import { ModelSelector } from './dialogs/model-selector'
import { PluginsSelector } from './dialogs/plugins-selector'
import { StartPermissionPrompt } from './dialogs/start-permission-prompt'
import { GoalStartPermissionPrompt } from './dialogs/goal-start-permission-prompt'
import { SwarmStartPermissionPrompt } from './dialogs/swarm-start-permission-prompt'
import { EffortSelector } from './dialogs/effort-selector'
import { UndoSelector } from './dialogs/undo-selector'
import { HelpPanel } from './dialogs/help-panel'
import { WhichKey } from './dialogs/which-key'

import { Box } from './common/box'
import { Text } from './common/text'

const LEFT_COL_RATIO = 0.7
const FULLSCREEN_DIALOGS = new Set<DialogKind>([
  'session-picker',
  'model-selector',
  'plugins-selector',
  'help',
])

export interface MainShellProps {
  /** Dispatch protocol to route dialog results back to the host. */
  readonly dispatch: DialogDispatch
  /** Terminal width in columns. */
  readonly width: number
  /** Terminal height in rows. */
  readonly height: number
  /** Activity pane mode (idle hides the pane). */
  readonly activityMode: 'idle' | 'waiting' | 'thinking' | 'composing' | 'tool'
  readonly activityTip?: string
  readonly activityDetail?: string
  readonly editorFocused?: boolean
  readonly editorPlaceholder?: string
  /** Called when the user submits the editor (Enter). The shell does NOT
   *  route the typed text anywhere — the host's editor-keyboard
   *  controller owns the send path. */
  readonly onEditorSubmit?: (text: string) => void
  /** Current editor text (controlled by the host for persistence). */
  readonly editorValue?: string
  readonly onEditorChange?: (value: string) => void
}

const leftWidth = (total: number): number => Math.floor(total * LEFT_COL_RATIO)
const rightWidth = (total: number): number => total - leftWidth(total)

export const MainShell: Component<MainShellProps> = (props) => {
  const store = useTui2Store()
  const borderFg = (): string => currentThemeFg('border')

  const transcript = (): readonly TranscriptEntry[] => store.state.transcript
  const showRightPane = (): boolean => {
    const dialog = store.state.activeDialog
    return dialog === null || !FULLSCREEN_DIALOGS.has(dialog as DialogKind)
  }

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <Banner state={store.state.banner} />

      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" flexGrow={1} width={leftWidth(props.width)}>
          <For each={transcript()}>{(entry) => <TranscriptEntryView entry={entry} />}</For>
        </Box>

        <Show when={showRightPane()}>
          <Box flexDirection="column" width={rightWidth(props.width)}>
            <Show when={store.state.queuePane !== undefined}>
              <QueuePane
                messages={store.state.queuePane?.messages ?? []}
                isCompacting={store.state.queuePane?.isCompacting ?? false}
                isStreaming={store.state.queuePane?.isStreaming ?? false}
                canSteerImmediately={store.state.queuePane?.canSteerImmediately ?? false}
              />
            </Show>
            <Show when={store.state.agentPane !== undefined}>
              <AgentPane items={store.state.agentPane?.items ?? []} />
            </Show>
            <Show when={props.activityMode !== 'idle'}>
              <ActivityPane
                mode={props.activityMode}
                tip={props.activityTip}
                detail={props.activityDetail}
              />
            </Show>
            <Show when={store.state.btwPanelOpen}>
              <BtwPanel width={rightWidth(props.width)} />
            </Show>
            <Show when={store.state.diffReviewItems !== undefined}>
              <DiffReviewPane
                items={store.state.diffReviewItems?.items ?? []}
                width={rightWidth(props.width)}
              />
            </Show>
          </Box>
        </Show>
      </Box>

      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>

      <ActiveDialogSlot dispatch={props.dispatch} />

      <CustomEditor
        placeholder={props.editorPlaceholder}
        focused={props.editorFocused ?? true}
        value={props.editorValue}
        onChange={props.onEditorChange}
        onSubmit={props.onEditorSubmit}
      />

      <Footer />
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Transcript entry dispatcher
// ---------------------------------------------------------------------------

const TranscriptEntryView: Component<{ entry: TranscriptEntry }> = (props) => {
  switch (props.entry.kind) {
    case 'user':
      return <UserMessageView content={props.entry.content} bullet={props.entry.bullet} />
    case 'assistant':
      return (
        <AssistantMessageView
          content={props.entry.content}
          expanded={props.entry.expanded}
          mode="finalized"
        />
      )
    case 'thinking':
      return (
        <ThinkingView
          content={props.entry.content}
          mode="finalized"
          expanded={props.entry.expanded}
        />
      )
    case 'status':
      return <StatusMessageView kind={props.entry.detail ?? 'info'} />
    case 'goal':
      return props.entry.goalData !== undefined ? (
        <GoalPanel goal={props.entry.goalData} />
      ) : null
    case 'welcome':
      return <PlanBox plan={{ steps: [], summary: props.entry.content }} />
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Active dialog slot
// ---------------------------------------------------------------------------

const ActiveDialogSlot: Component<{ dispatch: DialogDispatch }> = (props) => {
  const store = useTui2Store()
  const dialog = (): DialogKind | null => (store.state.activeDialog as DialogKind | null)
  const dispatch = props.dispatch
  const select = (result: DialogResult): void => dispatch.select(result)
  const cancel = (kind: DialogKind): void => dispatch.cancel(kind)

  return (
    <Show when={dialog() !== null}>
      <Show when={dialog() === 'session-picker'}>
        <SessionPicker
          sessions={store.state.sessionPicker?.sessions ?? []}
          loading={store.state.sessionPicker?.loading ?? false}
          currentSessionId={store.state.sessionPicker?.currentSessionId ?? ''}
          onSelect={(sessionId) => select({ kind: 'session-picker', sessionId })}
          onCancel={() => cancel('session-picker')}
        />
      </Show>
      <Show when={dialog() === 'model-selector'}>
        <ModelSelector
          models={store.state.modelSelector?.models ?? {}}
          currentValue={store.state.modelSelector?.currentValue ?? ''}
          currentThinkingEffort={store.state.modelSelector?.currentThinkingEffort ?? 'off'}
          onSelect={(s) => select({ kind: 'model-selector', alias: s.alias, effort: s.thinking })}
          onCancel={() => cancel('model-selector')}
        />
      </Show>
      <Show when={dialog() === 'plugins-selector'}>
        <PluginsSelector
          installed={store.state.pluginsSelector?.installed ?? []}
          onSelect={(s) => {
            // The plugins panel emits several action shapes; the dispatch
            // protocol only covers the top-level toggles here. Detailed
            // sub-flows (MCP / remove / reload / details / install) are
            // handled inside the panel's own callback tree.
            if (s.kind === 'toggle') {
              select({ kind: 'plugins-selector', action: 'toggle' })
            } else if (s.kind === 'remove') {
              select({ kind: 'plugins-selector', action: 'remove' })
            } else if (s.kind === 'mcp') {
              select({ kind: 'plugins-selector', action: 'mcp' })
            } else if (s.kind === 'details') {
              select({ kind: 'plugins-selector', action: 'details' })
            } else {
              select({ kind: 'plugins-selector', action: 'reload' })
            }
          }}
          onCancel={() => cancel('plugins-selector')}
        />
      </Show>
      <Show when={dialog() === 'theme-selector'}>
        <ThemeSelector
          currentValue={store.state.themeSelector?.currentValue ?? 'auto'}
          onSelect={(themeName) => select({ kind: 'theme-selector', themeName })}
          onCancel={() => cancel('theme-selector')}
        />
      </Show>
      <Show when={dialog() === 'locale-selector'}>
        <LocaleSelector
          currentValue={store.state.localeSelector?.currentValue ?? 'en'}
          onSelect={(locale) => select({ kind: 'locale-selector', locale })}
          onCancel={() => cancel('locale-selector')}
        />
      </Show>
      <Show when={dialog() === 'permission-selector'}>
        <PermissionSelector
          currentValue={store.state.permissionSelector?.currentValue ?? 'manual'}
          onSelect={(mode) => select({ kind: 'permission-selector', mode })}
          onCancel={() => cancel('permission-selector')}
        />
      </Show>
      <Show when={dialog() === 'editor-selector'}>
        <EditorSelector
          currentValue={store.state.editorSelector?.currentValue ?? ''}
          onSelect={(command) => select({ kind: 'editor-selector', command })}
          onCancel={() => cancel('editor-selector')}
        />
      </Show>
      <Show when={dialog() === 'update-preference'}>
        <UpdatePreferenceSelector
          currentValue={store.state.updatePreference?.currentValue ?? true}
          onSelect={(enabled) => select({ kind: 'update-preference', enabled })}
          onCancel={() => cancel('update-preference')}
        />
      </Show>
      <Show when={dialog() === 'msys2-prompt'}>
        <Msys2Prompt
          onSelect={(choice) => select({ kind: 'msys2-prompt', choice })}
          onCancel={() => cancel('msys2-prompt')}
        />
      </Show>
      <Show when={dialog() === 'trust-prompt'}>
        <TrustPrompt
          workDir={store.state.trustPrompt?.workDir ?? ''}
          gatedMcpServers={store.state.trustPrompt?.gatedMcpServers ?? []}
          onSelect={(choice) => select({ kind: 'trust-prompt', choice })}
        />
      </Show>
      <Show when={dialog() === 'settings-selector'}>
        <SettingsSelector
          onSelect={(value) => select({ kind: 'settings-selector', value })}
          onCancel={() => cancel('settings-selector')}
        />
      </Show>
      <Show when={dialog() === 'cache-hint'}>
        <CacheHintDialog
          idleSeconds={store.state.cacheHint?.idleSeconds ?? 0}
          totalTokens={store.state.cacheHint?.totalTokens ?? 0}
          onSelect={(action) => select({ kind: 'cache-hint', action })}
          onCancel={() => cancel('cache-hint')}
        />
      </Show>
      <Show when={dialog() === 'goal-queue-manager'}>
        <GoalStartPermissionPrompt
          mode={store.state.goalQueue?.mode ?? 'manual'}
          onSelect={(choice) => select({ kind: 'goal-queue-manager', choice })}
          onCancel={() => cancel('goal-queue-manager')}
        />
      </Show>
      <Show when={dialog() === 'undo-selector'}>
        <UndoSelector
          choices={store.state.undoSelector?.choices ?? []}
          onSelect={(choice) => select({ kind: 'undo-selector', choiceId: choice.id })}
          onCancel={() => cancel('undo-selector')}
        />
      </Show>
      <Show when={dialog() === 'effort-selector'}>
        <EffortSelector
          efforts={store.state.effortSelector?.efforts ?? []}
          currentValue={store.state.effortSelector?.currentValue ?? 'off'}
          onSelect={(effort) => select({ kind: 'effort-selector', effort })}
          onCancel={() => cancel('effort-selector')}
        />
      </Show>
      <Show when={dialog() === 'help'}>
        <HelpPanel
          commands={store.state.helpPanel?.commands ?? []}
          width={store.state.helpPanel?.width ?? 80}
          onClose={() => cancel('help')}
        />
      </Show>
      <Show when={dialog() === 'which-key'}>
        <WhichKey onClose={() => cancel('which-key')} />
      </Show>
      <Show when={dialog() === 'start-permission-prompt'}>
        <StartPermissionPrompt
          title={store.state.startPermission?.title ?? ''}
          noticeLines={store.state.startPermission?.noticeLines ?? []}
          options={store.state.startPermission?.options ?? []}
          onSelect={(choice) => select({ kind: 'start-permission-prompt', choice })}
          onCancel={() => cancel('start-permission-prompt')}
        />
      </Show>
      <Show when={dialog() === 'swarm-start-permission-prompt'}>
        <SwarmStartPermissionPrompt
          onSelect={(choice) => select({ kind: 'swarm-start-permission-prompt', choice })}
          onCancel={() => cancel('swarm-start-permission-prompt')}
        />
      </Show>
      <Show when={dialog() === 'approval-panel'}>
        <ApprovalPanel
          request={store.state.approval?.request}
          width={store.state.approval?.width ?? 80}
          onResponse={(response) => select({ kind: 'approval-panel', response })}
        />
      </Show>
      <Show when={dialog() === 'question-dialog'}>
        <QuestionDialog
          request={store.state.question?.request}
          width={store.state.question?.width ?? 80}
          onAnswer={(r) => select({ kind: 'question-dialog', method: r.method, answers: r.answers })}
        />
      </Show>
    </Show>
  )
}

// Tiny shim so the existing `currentTheme.fg(token)` call site below
// doesn't need a second import for a single string.
import { currentTheme } from '../theme'
const currentThemeFg = (token: 'border' | 'borderFocus' | 'primary' | 'text' | 'textDim' | 'textMuted'): string => {
  const input = currentTheme.color(token as Parameters<typeof currentTheme.color>[0])
  return typeof input === 'string' ? input : String(input)
}
void createSignal
