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

import type { Component } from 'solid-js';
import { createEffect, createSignal, For, Show } from 'solid-js';

import type { ColorInput } from '@opentui/core';

import { useTui2Store } from '../context';
import type { DialogDispatch, DialogKind, DialogResult } from '../dispatch';
import type { TuiRuntimeState } from '../state';
import { currentTheme } from '../theme';
import type { TranscriptEntry } from '../types';
import { BannerComponent } from './chrome/banner';
import {
  activeDeviceCodeCard,
  DeviceCodeBoxView,
  type ActiveDeviceCodeCard,
} from './chrome/device-code-box';
import { FooterView } from './chrome/footer';
import { TodoPanelView } from './chrome/todo-panel';
import { WelcomeView } from './chrome/welcome';
import { WorkflowPanelView } from './chrome/workflow-panel';
import { Box } from './common/box';
import { Clickable } from './common/clickable';
import { Text } from './common/text';
import { ApprovalPanel } from './dialogs/approval-panel';
import { ApprovalPreviewViewer, type ApprovalPreviewBlock } from './dialogs/approval-preview';
import { CacheHintDialog } from './dialogs/cache-hint-dialog';
import { CompactionView, compactionViewPropsFromData } from './dialogs/compaction';
import { EditorSelector } from './dialogs/editor-selector';
import { EffortSelector } from './dialogs/effort-selector';
import { GoalQueueEditDialog, GoalQueueManagerDialog } from './dialogs/goal-queue-manager';
import { GoalStartPermissionPrompt } from './dialogs/goal-start-permission-prompt';
import { HelpPanel } from './dialogs/help-panel';
import { LocaleSelector } from './dialogs/locale-selector';
import { ModelSelector } from './dialogs/model-selector';
import { Msys2Prompt } from './dialogs/msys2-prompt';
import { PermissionSelector } from './dialogs/permission-selector';
import {
  PluginInstallTrustConfirm,
  PluginMcpSelector,
  PluginRemoveConfirm,
  PluginsPanel,
} from './dialogs/plugins-selector';
import { QuestionDialog } from './dialogs/question-dialog';
import { SessionPicker } from './dialogs/session-picker';
import { SettingsSelector } from './dialogs/settings-selector';
import { StartPermissionPrompt } from './dialogs/start-permission-prompt';
import { SwarmStartPermissionPrompt } from './dialogs/swarm-start-permission-prompt';
import { TaskOutputViewer } from './dialogs/task-output-viewer';
import { TasksBrowser } from './dialogs/tasks-browser';
import { ThemeSelector } from './dialogs/theme-selector';
import { TrustPrompt } from './dialogs/trust-prompt';
import { UndoSelector } from './dialogs/undo-selector';
import { UpdatePreferenceSelector } from './dialogs/update-preference-selector';
import { WhichKey } from './dialogs/which-key';
import { CustomEditor } from './editor/custom-editor';
import { AgentGroupView } from './messages/agent-group';
import { AssistantMessageView } from './messages/assistant-message';
import { BackgroundAgentStatusView } from './messages/background-agent-status';
import { CronMessageView } from './messages/cron-message';
import { GoalSetMessageView } from './messages/goal-panel';
import { PluginCommandView } from './messages/plugin-command';
import { ReadGroupView } from './messages/read-group';
import { SkillActivationView } from './messages/skill-activation';
import { StatusMessageView } from './messages/status-message';
import { SwarmModeMarkerView } from './messages/swarm-markers';
import { ThinkingView } from './messages/thinking';
import { ToolCallView } from './messages/tool-call';
import {
  groupTranscriptEntries,
  type TranscriptDisplayItem,
  type TranscriptGroupMember,
} from './messages/transcript-groups';
import { UserMessageView } from './messages/user-message';
import { ActivityPane, type ActivityPaneMode } from './panes/activity-pane';
import { AgentPane } from './panes/agent-pane';
import { BtwPanel } from './panes/btw-panel';
import { DiffReviewPane } from './panes/diff-review-pane';
import { QueuePane } from './panes/queue-pane';

const LEFT_COL_RATIO = 0.7;
const FULLSCREEN_DIALOGS = new Set<DialogKind>([
  'session-picker',
  'model-selector',
  'plugins-selector',
  'help',
]);

export interface MainShellProps {
  /** Dispatch protocol to route dialog results back to the host. */
  readonly dispatch: DialogDispatch;
  /** Terminal width in columns. */
  readonly width: number;
  /** Terminal height in rows. */
  readonly height: number;
  /** Activity pane mode (hidden hides the pane). */
  readonly activityMode: ActivityPaneMode;
  readonly activityTip?: string;
  readonly activityDetail?: string;
  readonly editorFocused?: boolean;
  readonly editorPlaceholder?: string;
  /** Called when the user submits the editor (Enter). The shell does NOT
   *  route the typed text anywhere — the host's editor-keyboard
   *  controller owns the send path. */
  readonly onEditorSubmit?: (text: string) => void;
  readonly onEditorChange?: (value: string) => void;
  readonly onModelClick?: () => void;
  readonly onModeClick?: () => void;
  readonly onTasksClick?: () => void;
  readonly onGoalClick?: () => void;
  /** Ctrl+O while a dialog owns input (approval panel / question dialog):
   *  toggle tool-output expansion. Host-owned; the shell only forwards. */
  readonly onToggleToolOutput?: () => void;
}

const leftWidth = (total: number): number => Math.floor(total * LEFT_COL_RATIO);
const rightWidth = (total: number): number => total - leftWidth(total);

export const MainShell: Component<MainShellProps> = (props) => {
  const store = useTui2Store();
  const borderFg = (): ColorInput => currentTheme.color('border');

  const transcript = (): readonly TranscriptEntry[] => store.state.transcript;
  /** Consecutive same-`groupKey` tool calls fold into single group rows. */
  const displayItems = (): readonly TranscriptDisplayItem[] =>
    groupTranscriptEntries(transcript());
  const showRightPane = (): boolean => {
    const dialog = store.state.activeDialog;
    return dialog === null || !FULLSCREEN_DIALOGS.has(dialog as DialogKind);
  };

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <Show when={store.state.banner !== null}>
        <BannerComponent state={store.state.banner!} />
      </Show>

      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" flexGrow={1} width={leftWidth(props.width)}>
          <For each={displayItems()}>
            {(item) => <TranscriptDisplayItemView item={item} workspaceDir={store.state.workDir} />}
          </For>
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
            <Show when={store.state.agentPaneItems.length > 0}>
              <AgentPane items={store.state.agentPaneItems} />
            </Show>
            <Show when={props.activityMode !== 'hidden' || store.state.progressSpinner !== null}>
              <ActivityPane
                mode={store.state.progressSpinner !== null ? 'waiting' : props.activityMode}
                tip={store.state.progressSpinner?.label ?? props.activityTip}
                detail={props.activityDetail}
              />
            </Show>
            <Show when={store.state.btwPanel.active}>
              <BtwPanel width={rightWidth(props.width)} />
            </Show>
            <Show when={store.state.diffReviewItems.length > 0}>
              <DiffReviewPane
                items={store.state.diffReviewItems}
                width={rightWidth(props.width)}
              />
            </Show>
            <TodoPanelView />
            <WorkflowPanelView />
          </Box>
        </Show>
      </Box>

      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>

      <Show when={store.state.leaderOverlayVisible && store.state.activeDialog === null}>
        {/* Transient Ctrl-X hint: non-focusable, editor keeps focus and the
            host removes it when the chord fires or times out. */}
        <WhichKey focusable={false} />
      </Show>

      <ActiveDialogSlot
        dispatch={props.dispatch}
        width={props.width}
        height={props.height}
        onToggleToolOutput={props.onToggleToolOutput}
      />

      <Show
        when={store.state.editorReplacement === undefined}
        fallback={<EditorReplacementSlot />}
      >
        <CustomEditor
          width={props.width}
          placeholder={props.editorPlaceholder}
          focused={props.editorFocused ?? true}
          onChange={props.onEditorChange}
          onSubmit={props.onEditorSubmit}
        />
      </Show>

      <FooterView
        onModelClick={props.onModelClick}
        onModeClick={props.onModeClick}
        onTasksClick={props.onTasksClick}
        onGoalClick={props.onGoalClick}
      />
    </Box>
  );
};

/** Renders the command-layer editor replacement (v1 `mountEditorReplacement`
 *  equivalent): a slash command set `store.state.editorReplacement` with a
 *  component + props; the shell renders it in the editor slot until the
 *  command clears it. */
const EditorReplacementSlot: Component = () => {
  const store = useTui2Store();
  const replacement = (): NonNullable<TuiRuntimeState['editorReplacement']> | undefined =>
    store.state.editorReplacement ?? undefined;
  return (
    <Show when={replacement() !== undefined}>
      {(() => {
        const r = replacement()!;
        const Comp = r.component as Component<Record<string, unknown>>;
        return <Comp {...r.props} />;
      })()}
    </Show>
  );
};

// ---------------------------------------------------------------------------
// Transcript entry dispatcher
// ---------------------------------------------------------------------------

const TranscriptDisplayItemView: Component<{
  item: TranscriptDisplayItem
  workspaceDir: string
}> = (props) => {
  const store = useTui2Store();
  const toggleSingle = (entry: TranscriptEntry): void => {
    const list = store.state.transcript;
    const idx = list.indexOf(entry);
    if (idx === -1) return;
    const updated = [...list];
    updated[idx] = { ...entry, expanded: !entry.expanded };
    store.setState('transcript', updated);
  };
  const toggleGroup = (entryIds: ReadonlySet<string>): void => {
    const list = store.state.transcript;
    const anyExpanded = list.some((e) => entryIds.has(e.id) && e.expanded === true);
    const updated = list.map((e) => {
      if (entryIds.has(e.id)) {
        return { ...e, expanded: !anyExpanded };
      }
      return e;
    });
    store.setState('transcript', updated);
  };

  const item = props.item;
  if (item.kind === 'single') {
    return (
      <TranscriptEntryView
        entry={item.entry}
        workspaceDir={props.workspaceDir}
        onToggleExpanded={() => toggleSingle(item.entry)}
      />
    );
  }
  const members = (): readonly (TranscriptGroupMember & { readonly workspaceDir: string })[] =>
    item.members.map((member) => ({ ...member, workspaceDir: props.workspaceDir }));
  return (
    <Clickable onClick={() => toggleGroup(new Set(item.members.map((m) => m.entryId)))}>
      {item.tool === 'read' ? (
        <ReadGroupView members={members()} />
      ) : (
        <AgentGroupView members={members()} />
      )}
    </Clickable>
  );
};

const TranscriptEntryView: Component<{
  entry: TranscriptEntry
  workspaceDir: string
  onToggleExpanded?: () => void
}> = (props) => {
  const entry = props.entry;
  switch (entry.kind) {
    case 'user':
      return <UserMessageView content={entry.content} bullet={entry.bullet} />;
    case 'assistant':
      return <AssistantMessageView content={entry.content} />;
    case 'thinking':
      return (
        <ThinkingView
          content={entry.content}
          mode="finalized"
          expanded={entry.expanded}
          onToggle={props.onToggleExpanded}
        />
      );
    case 'status':
      return <StatusEntryView entry={entry} />;
    case 'goal':
      if (entry.goalData === undefined) return null;
      if (entry.goalData.kind === 'created') return <GoalSetMessageView />;
      return <StatusMessageView content={entry.content} />;
    case 'welcome':
      return <WelcomeEntryView />;
    case 'tool_call':
      if (entry.toolCallData === undefined) return null;
      return (
        <ToolCallView
          toolCall={entry.toolCallData}
          result={entry.toolCallData.result}
          expanded={entry.expanded}
          navigated={entry.navigated}
          workspaceDir={props.workspaceDir}
          progressLines={entry.toolCallData.progressLines}
          liveOutput={entry.toolCallData.liveOutput}
          detachHint={entry.toolCallData.detachHint}
          onToggle={props.onToggleExpanded}
        />
      );
    case 'skill_activation':
      return (
        <SkillActivationView
          name={entry.skillName ?? entry.content}
          args={entry.skillArgs}
          trigger={entry.skillTrigger}
        />
      );
    case 'plugin_command':
      if (entry.pluginCommandData === undefined) return null;
      return (
        <PluginCommandView
          pluginId={entry.pluginCommandData.pluginId}
          commandName={entry.pluginCommandData.commandName}
          args={entry.pluginCommandData.args}
        />
      );
    case 'cron':
      if (entry.cronData === undefined) return null;
      return <CronMessageView prompt={entry.content} data={entry.cronData} />;
    default:
      return null;
  }
};

/**
 * Status rows carry several payloads: compaction progress/result, swarm
 * enter/exit markers, background-agent cards, the pending OAuth device-code
 * login card, or plain status text.
 */
const StatusEntryView: Component<{ entry: TranscriptEntry }> = (props) => {
  const entry = props.entry;
  if (entry.compactionData !== undefined) {
    const viewProps = compactionViewPropsFromData(entry.compactionData);
    return <CompactionView {...viewProps} expanded={entry.expanded} />;
  }
  if (entry.swarmData !== undefined) {
    return <SwarmModeMarkerView state={entry.swarmData.state} />;
  }
  if (entry.backgroundAgentStatus !== undefined) {
    return <BackgroundAgentStatusView data={entry.backgroundAgentStatus} />;
  }
  // Reactive: the card arrives via signal while the entry stays untouched.
  const deviceCard = (): ActiveDeviceCodeCard | undefined => {
    const card = activeDeviceCodeCard();
    return card !== undefined && card.entryId === entry.id ? card : undefined;
  };
  return (
    <Show
      when={deviceCard()}
      keyed
      fallback={<StatusMessageView content={entry.content} color={entry.color} />}
    >
      {(card: ActiveDeviceCodeCard) => (
        <DeviceCodeBoxView title={card.title} url={card.url} code={card.code} hint={card.hint} />
      )}
    </Show>
  );
};

/** The startup welcome panel rendered for the `welcome` transcript entry. */
const WelcomeEntryView: Component = () => {
  const store = useTui2Store();
  return (
    <WelcomeView
      model={store.state.model}
      availableModels={store.state.availableModels}
      workDir={store.state.workDir}
      sessionId={store.state.sessionId}
      version={store.state.version}
      mcpServersSummary={store.state.mcpServersSummary}
    />
  );
};

// ---------------------------------------------------------------------------
// Active dialog slot
// ---------------------------------------------------------------------------

const ActiveDialogSlot: Component<{
  readonly dispatch: DialogDispatch;
  readonly width: number;
  readonly height: number;
  readonly onToggleToolOutput?: () => void;
}> = (props) => {
  const store = useTui2Store();
  const dialog = (): DialogKind | null => store.state.activeDialog as DialogKind | null;
  const dispatch = props.dispatch;
  const select = (result: DialogResult): void => dispatch.select(result);
  const cancel = (kind: DialogKind): void => dispatch.cancel(kind);

  // Ctrl+E full-content preview (v1 `ApprovalPreviewViewer` takeover): while
  // set, the viewer replaces the approval panel in this slot; Esc / Ctrl+E
  // returns to the panel. Cleared when the approval resolves or the dialog
  // changes.
  const [previewBlock, setPreviewBlock] = createSignal<ApprovalPreviewBlock | undefined>(
    undefined,
  );
  createEffect(() => {
    if (dialog() !== 'approval-panel' || store.state.livePane.pendingApproval === null) {
      setPreviewBlock(undefined);
    }
  });

  const editingGoal = (): import('../goal-queue-store').UpcomingGoal | undefined => {
    const qm = store.state.goalQueueManager;
    if (qm === undefined || qm.editingGoalId === undefined) return undefined;
    return qm.goals.find((goal) => goal.id === qm.editingGoalId);
  };

  return (
    <Show when={dialog() !== null}>
      <Show when={dialog() === 'session-picker'}>
        <SessionPicker
          sessions={store.state.sessions}
          loading={store.state.loadingSessions}
          currentSessionId={store.state.sessionId}
          scope={store.state.sessionsScope}
          hasMore={store.state.sessionsNextCursor !== undefined}
          loadingMore={store.state.sessionsLoadingMore}
          onSelect={(session) => select({ kind: 'session-picker', sessionId: session.id })}
          onToggleScope={(sessionId) =>
            select({ kind: 'session-picker-scope-toggle', sessionId })
          }
          onLoadMore={() => select({ kind: 'session-picker-load-more' })}
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
        <PluginsPanel
          installed={store.state.pluginsPanel?.installed ?? []}
          installedIds={store.state.pluginsPanel?.installedIds ?? new Set<string>()}
          catalogIsDefault={store.state.pluginsPanel?.catalogIsDefault}
          initialTab={store.state.pluginsPanel?.initialTab}
          selectedId={store.state.pluginsPanel?.selectedId}
          pluginHint={store.state.pluginsPanel?.pluginHint}
          onSelect={(s) => {
            // Forward the full payload to the host. Each kind of action
            // carries the pluginId (and, for toggles, the desired enabled
            // state) so the host can apply it.
            switch (s.kind) {
              case 'toggle':
                select({
                  kind: 'plugins-selector',
                  action: { kind: 'toggle', id: s.id, enabled: s.enabled },
                });
                return;
              case 'remove':
                select({ kind: 'plugins-selector', action: { kind: 'remove', id: s.id } });
                return;
              case 'mcp':
                select({ kind: 'plugins-selector', action: { kind: 'mcp', id: s.id } });
                return;
              case 'details':
                select({ kind: 'plugins-selector', action: { kind: 'details', id: s.id } });
                return;
              case 'reload':
                select({ kind: 'plugins-selector', action: { kind: 'reload' } });
                return;
              case 'install':
              case 'install-source':
              case 'open-url':
                // Install rows open an external auth flow; host wires it.
                void s;
                return;
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
          idleSeconds={store.state.cacheHintDialog?.idleSeconds ?? 0}
          totalTokens={store.state.cacheHintDialog?.totalTokens ?? 0}
          onSelect={(action) => select({ kind: 'cache-hint', action })}
          onCancel={() => cancel('cache-hint')}
        />
      </Show>
      <Show when={dialog() === 'goal-start-permission-prompt'}>
        <GoalStartPermissionPrompt
          mode={store.state.goalStartContext?.mode ?? 'manual'}
          onSelect={(choice) => select({ kind: 'goal-start-permission-prompt', choice })}
          onCancel={() => cancel('goal-start-permission-prompt')}
        />
      </Show>
      <Show when={dialog() === 'goal-queue-manager'}>
        <GoalQueueManagerDialog
          goals={store.state.goalQueueManager?.goals ?? []}
          selectedGoalId={store.state.goalQueueManager?.selectedGoalId}
          onAction={(action) => select({ kind: 'goal-queue-manager', action })}
          onCancel={() => cancel('goal-queue-manager')}
        />
      </Show>
      <Show when={dialog() === 'goal-queue-edit'}>
        <Show when={editingGoal() !== undefined}>
          <GoalQueueEditDialog
            goal={editingGoal()!}
            onDone={(result) => select({ kind: 'goal-queue-edit', result })}
          />
        </Show>
      </Show>
      <Show when={dialog() === 'undo-selector'}>
        <UndoSelector
          choices={store.state.undoChoices ?? []}
          onSelect={(choice) =>
            select({ kind: 'undo-selector', count: choice.count, input: choice.input })
          }
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
          width={store.state.helpPanel?.width ?? props.width}
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
      <Show when={dialog() === 'approval-panel' && store.state.livePane.pendingApproval !== null}>
        <Show
          when={previewBlock() !== undefined}
          fallback={
            <ApprovalPanel
              request={store.state.livePane.pendingApproval!}
              width={props.width}
              onResponse={(response) => select({ kind: 'approval-panel', response })}
              onToggleToolOutput={props.onToggleToolOutput}
              onOpenPreview={setPreviewBlock}
            />
          }
        >
          <ApprovalPreviewViewer
            block={previewBlock()!}
            viewRows={Math.max(6, props.height - 10)}
            width={props.width}
            onClose={() => setPreviewBlock(undefined)}
          />
        </Show>
      </Show>
      <Show when={dialog() === 'question-dialog' && store.state.livePane.pendingQuestion !== null}>
        <QuestionDialog
          request={store.state.livePane.pendingQuestion!}
          width={props.width}
          onToggleToolOutput={props.onToggleToolOutput}
          onAnswer={(r) =>
            select({ kind: 'question-dialog', method: r.method, answers: r.answers })
          }
        />
      </Show>
      <Show when={dialog() === 'plugins-confirm' && store.state.pluginConfirm !== null}>
        {(() => {
          const confirm = store.state.pluginConfirm!;
          if (confirm.kind === 'remove') {
            return (
              <PluginRemoveConfirm
                id={confirm.id}
                displayName={confirm.displayName}
                onDone={(result) =>
                  select({ kind: 'plugins-confirm', confirmed: result.kind === 'confirm' })
                }
              />
            );
          }
          return (
            <PluginInstallTrustConfirm
              label={confirm.label}
              onDone={(result) =>
                select({ kind: 'plugins-confirm', confirmed: result.kind === 'confirm' })
              }
            />
          );
        })()}
      </Show>
      <Show when={dialog() === 'plugins-mcp' && store.state.pluginMcpPicker !== null}>
        <PluginMcpSelector
          info={store.state.pluginMcpPicker!.info}
          selectedServer={store.state.pluginMcpPicker!.selectedServer}
          serverHint={store.state.pluginMcpPicker!.serverHint}
          onSelect={(selection) => select({ kind: 'plugins-mcp', selection })}
          onCancel={() => cancel('plugins-mcp')}
        />
      </Show>
      <Show when={dialog() === 'tasks-browser' && store.state.tasksBrowser !== undefined}>
        {(() => {
          const browser = store.state.tasksBrowser!;
          if (browser.viewer !== undefined) {
            const info = browser.tasks.find((task) => task.taskId === browser.viewer!.taskId);
            return (
              <TaskOutputViewer
              taskId={browser.viewer.taskId}
              info={info}
              output={browser.viewer.output}
              viewRows={24}
              width={props.width}
              onClose={() => select({ kind: 'tasks-browser', action: 'close-viewer' })}
            />
          );
          }
          return (
            <TasksBrowser
              tasks={browser.tasks}
              filter={browser.filter}
              selectedTaskId={browser.selectedTaskId}
              tailOutput={browser.tailOutput}
              tailLoading={browser.tailLoading}
              flashMessage={browser.flashMessage}
              width={props.width}
              height={props.height}
              onSelect={(taskId) => select({ kind: 'tasks-browser', action: 'select', taskId })}
              onToggleFilter={() => select({ kind: 'tasks-browser', action: 'toggle-filter' })}
              onRefresh={() => select({ kind: 'tasks-browser', action: 'refresh' })}
              onCancel={() => select({ kind: 'tasks-browser', action: 'cancel' })}
              onStopConfirmed={(taskId) =>
                select({ kind: 'tasks-browser', action: 'stop', taskId })
              }
              onOpenOutput={(taskId) =>
                select({ kind: 'tasks-browser', action: 'open-output', taskId })
              }
            />
          );
        })()}
      </Show>
    </Show>
  );
};

// `currentTheme` is imported at the top of the file (for the color tokens
// used in the render helpers below). No additional shim is needed.
