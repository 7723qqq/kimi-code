import type { BackgroundTaskInfo, Session } from '@moonshot-ai/kimi-code-sdk';
import type { ProcessTerminal, TUI } from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import type { Theme } from '#/tui/theme';

import { TasksPanelComponent, type TasksTab } from '../components/dialogs/tasks-browser';
import type { CustomEditor } from '../components/editor/custom-editor';
import type { AppState } from '../types';
import {
  beginScreenTakeover,
  endScreenTakeover,
  type ScreenTakeover,
} from '../utils/screen-takeover';
import type { SessionEventHandler } from './session-event-handler';

export interface TasksBrowserHost {
  readonly state: {
    readonly tasksBrowser: TasksBrowserState | undefined;
    readonly theme: Theme;
    readonly terminal: ProcessTerminal;
    readonly ui: TUI;
    readonly editor: CustomEditor;
    readonly appState: Pick<AppState, 'availableModels'>;
  };
  readonly backgroundTasks: ReadonlyMap<string, BackgroundTaskInfo>;
  readonly sessionEventHandler: SessionEventHandler;
  readonly session: Session | undefined;
  showError(msg: string): void;
  setTasksBrowser(value: TasksBrowserState | undefined): void;
}

export type TasksBrowserState = {
  component: TasksPanelComponent;
  takeover: ScreenTakeover;
  tab: TasksTab;
  selectedTaskId: string | undefined;
  /** Captured output of the selected task, straight from the engine. */
  output: string | undefined;
  outputLoading: boolean;
  outputRequestId: number;
  flashMessage: string | undefined;
  flashTimer: NodeJS.Timeout | undefined;
  pollTimer: NodeJS.Timeout | undefined;
};

export class TasksBrowserController {
  private refreshing = false;

  constructor(private readonly host: TasksBrowserHost) {}

  async show(): Promise<void> {
    const { state } = this.host;
    if (state.tasksBrowser !== undefined) return;

    const session = this.host.session;
    if (session === undefined) {
      this.host.showError(t('tui.statusMessages.noActiveSession'));
      return;
    }

    let tasks: readonly BackgroundTaskInfo[] = [];
    try {
      tasks = await session.listBackgroundTasks({ activeOnly: false });
    } catch (error) {
      this.host.showError(
        t('tui.messages.tasksLoadFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }
    if (state.tasksBrowser !== undefined) return;

    const tab: TasksTab = 'all';
    const selectedTaskId = this.pickInitialSelection(tasks, tab);
    const component = new TasksPanelComponent({
      tasks,
      tab,
      selectedTaskId,
      height: state.terminal.rows,
      output: undefined,
      outputLoading: false,
      activity: undefined,
      cwd: session.workDir,
      flashMessage: undefined,
      availableModels: state.appState.availableModels,
      ...this.buildCallbacks(),
    });

    const takeover = beginScreenTakeover(state.ui, component);
    state.ui.setFocus(component);
    state.ui.requestRender(true);

    const pollTimer = setInterval(() => {
      void this.refresh({ silent: true });
    }, 1000);

    this.host.setTasksBrowser({
      component,
      takeover,
      tab,
      selectedTaskId,
      output: undefined,
      outputLoading: false,
      outputRequestId: 0,
      flashMessage: undefined,
      flashTimer: undefined,
      pollTimer,
    });

    if (selectedTaskId !== undefined) {
      void this.loadOutput(selectedTaskId);
    }
  }

  close(): void {
    const { state } = this.host;
    const browser = state.tasksBrowser;
    if (browser === undefined) return;
    if (browser.pollTimer !== undefined) clearInterval(browser.pollTimer);
    if (browser.flashTimer !== undefined) clearTimeout(browser.flashTimer);

    endScreenTakeover(state.ui, browser.takeover);
    this.host.setTasksBrowser(undefined);
    state.ui.setFocus(state.editor);
    state.ui.requestRender(true);
  }

  repaint(): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    this.pushProps([...this.host.backgroundTasks.values()]);
  }

  /** Re-read the captured output of the selected task. */
  async refreshOutputViewer(opts: { silent?: boolean } = {}): Promise<void> {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined || browser.selectedTaskId === undefined) return;
    await this.loadOutput(browser.selectedTaskId, opts);
  }

  // ---------------------------------------------------------------------------

  private pickInitialSelection(
    tasks: readonly BackgroundTaskInfo[],
    tab: TasksTab,
  ): string | undefined {
    const candidates = this.tasksForTab(tasks, tab);
    if (candidates.length === 0) return undefined;
    return candidates.find((t) => t.status === 'running')?.taskId ?? candidates[0]!.taskId;
  }

  private tasksForTab(
    tasks: readonly BackgroundTaskInfo[],
    tab: TasksTab,
  ): readonly BackgroundTaskInfo[] {
    const backgroundOnly = tasks.filter((t) => t.detached !== false);
    if (tab === 'all') return backgroundOnly;
    if (tab === 'running') return backgroundOnly.filter((t) => t.status === 'running');
    return backgroundOnly.filter(
      (t) =>
        t.status === 'completed' ||
        t.status === 'failed' ||
        t.status === 'timed_out' ||
        t.status === 'killed' ||
        t.status === 'lost',
    );
  }

  private async refresh(opts: { silent?: boolean } = {}): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const { state } = this.host;
      const browser = state.tasksBrowser;
      if (browser === undefined) return;

      const session = this.host.session;
      if (session === undefined) return;

      let tasks: readonly BackgroundTaskInfo[];
      try {
        tasks = await session.listBackgroundTasks({ activeOnly: false });
      } catch (error) {
        if (!opts.silent) {
          this.flash(
            t('tui.messages.tasksRefreshFailed', {
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
        return;
      }
      if (state.tasksBrowser !== browser) return;
      this.pushProps(tasks);
      if (browser.selectedTaskId !== undefined) {
        await this.loadOutput(browser.selectedTaskId, { silent: true });
      }
    } finally {
      this.refreshing = false;
    }
  }

  private pushProps(tasks: readonly BackgroundTaskInfo[]): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    browser.component.setProps({
      tasks,
      tab: browser.tab,
      selectedTaskId: browser.selectedTaskId,
      height: this.host.state.terminal.rows,
      output: browser.output,
      outputLoading: browser.outputLoading,
      activity: this.activityFor(browser.selectedTaskId),
      cwd: this.host.session?.workDir,
      flashMessage: browser.flashMessage,
      availableModels: this.host.state.appState.availableModels,
      ...this.buildCallbacks(),
    });
    this.host.state.ui.requestRender();
  }

  /** The in-memory activity of the selected agent task, when this session holds one. */
  private activityFor(taskId: string | undefined) {
    if (taskId === undefined) return undefined;
    const info = this.host.backgroundTasks.get(taskId);
    if (info?.kind !== 'agent' || info.agentId === undefined) return undefined;
    return this.host.sessionEventHandler.subAgentEventHandler.activityStore.get(info.agentId);
  }

  private buildCallbacks(): {
    onSelect: (taskId: string) => void;
    onTabChange: (tab: TasksTab) => void;
    onRefresh: () => void;
    onCancel: () => void;
    onStop: (taskId: string) => void;
    onStopIgnored: (taskId: string, reason: 'terminal') => void;
  } {
    return {
      onSelect: (taskId) => {
        this.handleSelect(taskId);
      },
      onTabChange: (tab) => {
        this.handleTabChange(tab);
      },
      onRefresh: () => {
        this.handleRefresh();
      },
      onCancel: () => {
        this.close();
      },
      onStop: (taskId) => {
        void this.handleStop(taskId);
      },
      onStopIgnored: (taskId, reason) => {
        if (reason === 'terminal') {
          this.flash(t('tui.messages.tasksAlreadyTerminal', { taskId }));
        }
      },
    };
  }

  private handleSelect(taskId: string): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    if (browser.selectedTaskId === taskId) return;
    browser.selectedTaskId = taskId;
    browser.output = undefined;
    browser.outputLoading = true;
    this.repaint();
    void this.loadOutput(taskId);
  }

  private handleTabChange(tab: TasksTab): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    browser.tab = tab;
    this.repaint();
  }

  private handleRefresh(): void {
    this.flash(t('tui.messages.tasksRefreshing'), 600);
    void this.refresh();
  }

  private async handleStop(taskId: string): Promise<void> {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;

    const session = this.host.session;
    if (session === undefined) {
      this.flash(t('tui.statusMessages.noActiveSession'));
      return;
    }

    this.flash(t('tui.messages.tasksStopping', { taskId }), 1500);
    try {
      await session.stopBackgroundTask(taskId, {
        reason: t('tui.messages.tasksStopReasonUserInitiated'),
      });
      await this.refresh({ silent: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.flash(t('tui.messages.tasksStopFailed', { message }));
    }
  }

  /**
   * Load the captured output of a task. The engine's output log is the source
   * of truth — it survives a session restart, unlike the in-memory activity
   * of a subagent, so the panel can always show what a task printed.
   */
  private async loadOutput(
    taskId: string,
    opts: { silent?: boolean } = {},
  ): Promise<void> {
    const { state } = this.host;
    const browser = state.tasksBrowser;
    if (browser === undefined) return;

    const session = this.host.session;
    if (session === undefined) {
      browser.outputLoading = false;
      this.repaint();
      return;
    }

    const requestId = ++browser.outputRequestId;
    try {
      const output = await session.getBackgroundTaskOutput(taskId, { tail: 4000 });
      const current = state.tasksBrowser;
      if (current === undefined || current !== browser) return;
      if (current.outputRequestId !== requestId) return;
      if (current.selectedTaskId !== taskId) return;
      current.output = output;
      current.outputLoading = false;
    } catch (error) {
      const current = state.tasksBrowser;
      if (current === undefined || current !== browser) return;
      if (current.outputRequestId !== requestId) return;
      if (current.selectedTaskId !== taskId) return;
      if (!opts.silent) {
        const message = error instanceof Error ? error.message : String(error);
        this.flash(t('tui.messages.tasksOutputRefreshFailed', { message }));
      }
      current.output = '';
      current.outputLoading = false;
    }
    this.repaint();
  }

  private flash(message: string, durationMs = 2500): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    if (browser.flashTimer !== undefined) clearTimeout(browser.flashTimer);
    browser.flashMessage = message;
    browser.flashTimer = setTimeout(() => {
      const current = this.host.state.tasksBrowser;
      if (current !== browser) return;
      current.flashMessage = undefined;
      current.flashTimer = undefined;
      this.repaint();
    }, durationMs);
    this.repaint();
  }
}
