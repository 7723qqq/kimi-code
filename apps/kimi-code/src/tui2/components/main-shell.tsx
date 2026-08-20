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
 * Component structure:
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ Banner (banner-provider)                                  │
 *   ├──────────────────────────────┬──────────────────────────┤
 *   │                              │                          │
 *   │   Transcript (transcript)    │   Pane (right column):    │
 *   │   - assistant / user / tool  │   - queue / agent /       │
 *   │   - thinking / status       │     activity / btw /      │
 *   │                              │     help / diff-review    │
 *   │                              │                          │
 *   ├──────────────────────────────┴──────────────────────────┤
 *   │ Editor (custom-editor)                                   │
 *   ├─────────────────────────────────────────────────────────┤
 *   │ Footer (footer)                                          │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Dialogs (approval / question / session-picker / etc.) mount on top
 * of the shell via `store.state.activeDialog`; the shell renders a
 * single dialog slot that the host switches based on that slice.
 *
 * Status: REAL (tui2). Top-level shell view.
 */

import type { Component } from 'solid-js'
import { For, Show } from 'solid-js'
import type { ColorInput } from '@opentui/core'

import { useTui2Store } from '../context'
import { currentTheme } from '../theme'

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
import { ChoicePicker } from './dialogs/choice-picker'
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

export interface MainShellProps {
  /** Width of the terminal in columns. */
  readonly width: number
  /** Height of the terminal in rows. */
  readonly height: number
  /** Active pane mode (idle / waiting / thinking / composing / tool). */
  readonly activityMode: 'idle' | 'waiting' | 'thinking' | 'composing' | 'tool'
  /** Tips for the activity pane. */
  readonly activityTip?: string
  readonly activityDetail?: string
  /** Editor placeholder. */
  readonly editorPlaceholder?: string
  /** Whether the editor is focused. */
  readonly editorFocused?: boolean
  /** Editor value / change / submit callbacks. */
  readonly editorValue?: string
  readonly onEditorChange?: (value: string) => void
  readonly onEditorSubmit?: (value: string) => void
  /** Footer / help hint copy. */
  readonly footerHint?: string
}

export const MainShell: Component<MainShellProps> = (props) => {
  const store = useTui2Store()
  const borderFg = (): ColorInput => currentTheme.color('border')

  const transcriptEntries = (): readonly { id: string; kind: string }[] =>
    store.state.transcript
  const showRightPane = (): boolean => {
    const dialog = store.state.activeDialog
    if (dialog === null) return true
    // Most dialogs are full-screen overlays; only the light ones (settings
    // selector, help, etc.) leave the right pane visible. For now we keep
    // the right pane visible for any non-fullscreen dialog.
    return !['session-picker', 'model-selector', 'plugins-selector', 'help'].includes(dialog)
  }

  return (
    <Box flexDirection="column" width="100%" height="100%">
      {/* Banner */}
      <Banner state={store.state.banner} />

      {/* Main body: transcript + (optional) right pane */}
      <Box flexDirection="row" flexGrow={1}>
        {/* Transcript column */}
        <Box flexDirection="column" flexGrow={1} width={Math.floor(props.width * 0.7)}>
          <For each={transcriptEntries()}>
            {(entry) => <TranscriptEntry entry={entry} width={Math.floor(props.width * 0.7)} />}
          </For>
        </Box>

        {/* Right column: panes / dialog sidecar */}
        <Show when={showRightPane()}>
          <Box flexDirection="column" width={Math.floor(props.width * 0.3)}>
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
              <BtwPanel width={Math.floor(props.width * 0.3)} />
            </Show>
            <Show when={store.state.diffReviewItems !== undefined}>
              <DiffReviewPane
                items={store.state.diffReviewItems?.items ?? []}
                width={Math.floor(props.width * 0.3)}
              />
            </Show>
          </Box>
        </Show>
      </Box>

      {/* Border between body and editor */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>

      {/* Active dialog slot */}
      <ActiveDialogSlot />

      {/* Editor */}
      <CustomEditor
        placeholder={props.editorPlaceholder}
        focused={props.editorFocused ?? true}
        onChange={props.onEditorChange}
        onSubmit={props.onEditorSubmit}
      />

      {/* Footer */}
      <Footer hint={props.footerHint} />
    </Box>
  )
}

// ---------------------------------------------------------------------------
// Transcript entry dispatcher
// ---------------------------------------------------------------------------

const TranscriptEntry: Component<{ entry: { id: string; kind: string }; width: number }> = (
  props,
) => {
  const kind = (): string => props.entry.kind
  return (
    <Show when={true}>
      {(() => {
        switch (kind()) {
          case 'user':
            return <UserMessageView content={(props.entry as { content: string }).content} />
          case 'assistant':
            return (
              <AssistantMessageView
                content={(props.entry as { content: string }).content}
                expanded
                mode="finalized"
              />
            )
          case 'thinking':
            return (
              <ThinkingView
                content={(props.entry as { content: string }).content}
                mode="finalized"
                expanded={false}
              />
            )
          case 'plan':
            return <PlanBox plan={(props.entry as unknown as { plan: unknown }).plan} />
          case 'goal':
            return <GoalPanel goal={(props.entry as unknown as { goal: unknown }).goal} />
          case 'status':
            return <StatusMessageView kind={(props.entry as unknown as { kind: string }).kind} />
          default:
            return null
        }
      })()}
    </Show>
  )
}

// ---------------------------------------------------------------------------
// Active dialog slot
// ---------------------------------------------------------------------------

const ActiveDialogSlot: Component = () => {
  const store = useTui2Store()
  const dialog = (): string | null => store.state.activeDialog
  return (
    <Show when={dialog() !== null}>
      <Show when={dialog() === 'session-picker'}>
        <SessionPicker
          sessions={store.state.sessionPicker?.sessions ?? []}
          loading={store.state.sessionPicker?.loading ?? false}
          currentSessionId={store.state.sessionPicker?.currentSessionId ?? ''}
          onSelect={() => {}}
          onCancel={() => {}}
        />
      </Show>
      <Show when={dialog() === 'model-selector'}>
        <ModelSelector
          models={store.state.modelSelector?.models ?? {}}
          currentValue={store.state.modelSelector?.currentValue ?? ''}
          currentThinkingEffort={store.state.modelSelector?.currentThinkingEffort ?? 'off'}
          onSelect={() => {}}
          onCancel={() => {}}
        />
      </Show>
      <Show when={dialog() === 'plugins-selector'}>
        <PluginsSelector
          installed={store.state.pluginsSelector?.installed ?? []}
          onSelect={() => {}}
          onCancel={() => {}}
        />
      </Show>
      <Show when={dialog() === 'theme-selector'}>
        <ThemeSelector
          currentValue={store.state.themeSelector?.currentValue ?? 'auto'}
          onSelect={() => {}}
          onCancel={() => {}}
        />
      </Show>
      <Show when={dialog() === 'locale-selector'}>
        <LocaleSelector
          currentValue={store.state.localeSelector?.currentValue ?? 'en'}
          onSelect={() => {}}
          onCancel={() => {}}
        />
      </Show>
      <Show when={dialog() === 'permission-selector'}>
        <PermissionSelector
          currentValue={store.state.permissionSelector?.currentValue ?? 'manual'}
          onSelect={() => {}}
          onCancel={() => {}}
        />
      </Show>
      <Show when={dialog() === 'editor-selector'}>
        <EditorSelector
          currentValue={store.state.editorSelector?.currentValue ?? ''}
          onSelect={() => {}}
          onCancel={() => {}}
        />
      </Show>
      <Show when={dialog() === 'update-preference'}>
        <UpdatePreferenceSelector
          currentValue={store.state.updatePreference?.currentValue ?? true}
          onSelect={() => {}}
          onCancel={() => {}}
        />
      </Show>
      <Show when={dialog() === 'msys2-prompt'}>
        <Msys2Prompt onSelect={() => {}} onCancel={() => {}} />
      </Show>
      <Show when={dialog() === 'trust-prompt'}>
        <TrustPrompt
          workDir={store.state.trustPrompt?.workDir ?? ''}
          gatedMcpServers={store.state.trustPrompt?.gatedMcpServers ?? []}
          onSelect={() => {}}
        />
      </Show>
      <Show when={dialog() === 'settings-selector'}>
        <SettingsSelector onSelect={() => {}} onCancel={() => {}} />
      </Show>
      <Show when={dialog() === 'cache-hint'}>
        <CacheHintDialog
          idleSeconds={store.state.cacheHint?.idleSeconds ?? 0}
          totalTokens={store.state.cacheHint?.totalTokens ?? 0}
          onSelect={() => {}}
          onCancel={() => {}}
        />
      </Show>
      <Show when={dialog() === 'goal-queue-manager'}>
        <GoalStartPermissionPrompt
          mode={store.state.goalQueue?.mode ?? 'manual'}
          onSelect={() => {}}
          onCancel={() => {}}
        />
      </Show>
      <Show when={dialog() === 'undo-selector'}>
        <UndoSelector
          choices={store.state.undoSelector?.choices ?? []}
          onSelect={() => {}}
          onCancel={() => {}}
        />
      </Show>
      <Show when={dialog() === 'effort-selector'}>
        <EffortSelector
          efforts={store.state.effortSelector?.efforts ?? []}
          currentValue={store.state.effortSelector?.currentValue ?? 'off'}
          onSelect={() => {}}
          onCancel={() => {}}
        />
      </Show>
      <Show when={dialog() === 'help'}>
        <HelpPanel
          commands={store.state.helpPanel?.commands ?? []}
          width={store.state.helpPanel?.width ?? 80}
          onClose={() => {}}
        />
      </Show>
      <Show when={dialog() === 'which-key'}>
        <WhichKey onClose={() => {}} />
      </Show>
      <Show when={dialog() === 'start-permission-prompt'}>
        <StartPermissionPrompt
          title={store.state.startPermission?.title ?? ''}
          noticeLines={store.state.startPermission?.noticeLines ?? []}
          options={store.state.startPermission?.options ?? []}
          onSelect={() => {}}
          onCancel={() => {}}
        />
      </Show>
      <Show when={dialog() === 'swarm-start-permission-prompt'}>
        <SwarmStartPermissionPrompt onSelect={() => {}} onCancel={() => {}} />
      </Show>
      <Show when={dialog() === 'approval-panel'}>
        <ApprovalPanel
          request={store.state.approval?.request}
          width={store.state.approval?.width ?? 80}
          onResponse={() => {}}
        />
      </Show>
      <Show when={dialog() === 'question-dialog'}>
        <QuestionDialog
          request={store.state.question?.request}
          width={store.state.question?.width ?? 80}
          onAnswer={() => {}}
        />
      </Show>
    </Show>
  )
}

// Re-export ChoicePicker so it can be referenced from the host's keymap
// when wiring slash-command dispatch (e.g. `/theme` opens the dialog).
export { ChoicePicker }