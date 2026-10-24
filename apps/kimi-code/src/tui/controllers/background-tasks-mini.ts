import type { BackgroundTaskInfo, Session } from '@moonshot-ai/kimi-code-sdk';
import type { Container, ProcessTerminal, TUI, VStack } from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import type { Theme } from '#/tui/theme';
import { BackgroundTasksMiniPanel } from '../components/dialogs/background-tasks-mini';
import type { TasksTab } from '../components/dialogs/tasks-browser';
import type { CustomEditor } from '../components/editor/custom-editor';
import type { AppState } from '../types';

import type { SessionEventHandler } from './session-event-handler';
import { TasksBrowserController } from './tasks-browser';

export interface BackgroundTasksMiniHost {
  readonly state: {
    readonly tasksBrowserMini: BackgroundTasksMiniState | undefined;
    readonly backgroundTasksMiniContainer: Container;
    readonly dockContainer: VStack | undefined;
    readonly theme: Theme;
    readonly terminal: ProcessTerminal;
    readonly ui: TUI;
    readonly editor: CustomEditor;
    readonly appState: Pick<AppState, 'availableModels'>;
  };
  readonly backgroundTasks: ReadonlyMap<string, BackgroundTaskInfo>;
  readonly sessionEventHandler: SessionEventHandler;
  readonly session: Session | undefined;
  readonly tasksBrowserController: TasksBrowserController;
  showError(msg: string): void;
  setTasksBrowserMini(value: BackgroundTasksMiniState | undefined): void;
}

export type BackgroundTasksMiniState = {
  component: BackgroundTasksMiniPanel;
  tab: TasksTab;
  selectedTaskId: string | undefined;
  output: string | undefined;
  outputLoading: boolean;
  flashMessage: string | undefined;
  flashTimer: NodeJS.Timeout | undefined;
  pollTimer: NodeJS.Timeout | undefined;
};

export class BackgroundTasksMiniController {
  private refreshing = false;
  private hiddenDockEntries: { component: any; options: Record<string, unknown> }[] = [];

  constructor(private readonly host: BackgroundTasksMiniHost) {}

  async show(): Promise<void> {
    const { state } = this.host;
    if (state.tasksBrowserMini !== undefined) return;

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
    if (state.tasksBrowserMini !== undefined) return;

    const tab: TasksTab = 'all';
    const selectedTaskId = tasks.length > 0 ? tasks[0]!.taskId : undefined;
    const component = new BackgroundTasksMiniPanel({
      tasks,
      tab,
      selectedTaskId,
      height: Math.floor(state.terminal.rows * 0.5),
      output: undefined,
      outputLoading: false,
      activity: undefined,
      cwd: session.workDir,
      flashMessage: undefined,
      availableModels: state.appState.availableModels,
      onSelect: (taskId) => this.handleSelect(taskId),
      onTabChange: (t) => this.handleTabChange(t),
      onRefresh: () => this.handleRefresh(),
      onCancel: () => this.close(),
      onStop: (taskId) => void this.handleStop(taskId),
      onStopIgnored: () => {},
      onAmplify: () => this.amplify(),
    });

    const container = state.backgroundTasksMiniContainer;
    // In fullscreen mode the dock is a flex column: leaving the other chrome
    // (editor, footer, ...) in place would shrink the transcript to a single
    // row once the panel claims half the height. Hide them while the mini
    // panel is open and restore them on close.
    const dock = state.dockContainer;
    if (dock !== undefined && this.hiddenDockEntries.length === 0) {
      const entries = (dock as unknown as { entries: any[] }).entries;
      // `removeChild` splices `entries`, so iterate a copy.
      // oxlint-disable-next-line unicorn/no-useless-spread
      for (const entry of [...entries]) {
        if (entry.component === container) continue;
        this.hiddenDockEntries.push({
          component: entry.component,
          options: {
            basis: entry.basis,
            grow: entry.grow,
            shrink: entry.shrink,
            minSize: entry.minSize,
            maxSize: entry.maxSize,
            visible: entry.visible,
          },
        });
        dock.removeChild(entry.component);
      }
    }
    container.clear();
    container.addChild(component);
    state.ui.setFocus(component);
    state.ui.requestRender(true);

    const pollTimer = setInterval(() => {
      void this.refresh({ silent: true });
    }, 1000);

    this.host.setTasksBrowserMini({
      component,
      tab,
      selectedTaskId,
      output: undefined,
      outputLoading: false,
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
    const browser = state.tasksBrowserMini;
    if (browser === undefined) return;
    if (browser.pollTimer !== undefined) clearInterval(browser.pollTimer);
    if (browser.flashTimer !== undefined) clearTimeout(browser.flashTimer);

    state.backgroundTasksMiniContainer.clear();
    const dock = state.dockContainer;
    if (dock !== undefined && this.hiddenDockEntries.length > 0) {
      for (const { component, options } of this.hiddenDockEntries) {
        dock.addChild(component, options as any);
      }
      this.hiddenDockEntries = [];
    }
    this.host.setTasksBrowserMini(undefined);
    state.ui.setFocus(state.editor);
    state.ui.requestRender(true);
  }

  private async refresh(opts: { silent?: boolean } = {}): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const { state } = this.host;
      const browser = state.tasksBrowserMini;
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
      if (state.tasksBrowserMini !== browser) return;
      browser.component.setProps({
        tasks,
        tab: browser.tab,
        selectedTaskId: browser.selectedTaskId,
        height: Math.floor(state.terminal.rows * 0.5),
        output: browser.output,
        outputLoading: browser.outputLoading,
        activity: undefined,
        cwd: session.workDir,
        flashMessage: browser.flashMessage,
        availableModels: state.appState.availableModels,
        onSelect: (taskId) => this.handleSelect(taskId),
        onTabChange: (tab) => this.handleTabChange(tab),
        onRefresh: () => this.handleRefresh(),
        onCancel: () => this.close(),
        onStop: (taskId) => void this.handleStop(taskId),
        onStopIgnored: () => {},
        onAmplify: () => this.amplify(),
      });
      state.ui.requestRender();
    } finally {
      this.refreshing = false;
    }
  }

  private handleSelect(taskId: string): void {
    const browser = this.host.state.tasksBrowserMini;
    if (browser === undefined) return;
    if (browser.selectedTaskId === taskId) return;
    browser.selectedTaskId = taskId;
    browser.output = undefined;
    browser.outputLoading = true;
    this.refreshProps();
    void this.loadOutput(taskId);
  }

  private handleTabChange(tab: TasksTab): void {
    const browser = this.host.state.tasksBrowserMini;
    if (browser === undefined) return;
    browser.tab = tab;
    this.refreshProps();
  }

  private handleRefresh(): void {
    this.flash(t('tui.messages.tasksRefreshing'), 600);
    void this.refresh();
  }

  private async handleStop(taskId: string): Promise<void> {
    const browser = this.host.state.tasksBrowserMini;
    if (browser === undefined) return;
    const session = this.host.session;
    if (session === undefined) return;
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

  private async loadOutput(taskId: string): Promise<void> {
    const { state } = this.host;
    const browser = state.tasksBrowserMini;
    if (browser === undefined || browser.selectedTaskId !== taskId) return;
    const session = this.host.session;
    if (session === undefined) return;
    try {
      const output = await session.getBackgroundTaskOutput(taskId, { tail: 2000 });
      const current = state.tasksBrowserMini;
      if (current === undefined || current !== browser) return;
      if (current.selectedTaskId !== taskId) return;
      current.output = output;
      current.outputLoading = false;
    } catch {
      const current = state.tasksBrowserMini;
      if (current === undefined || current !== browser) return;
      if (current.selectedTaskId !== taskId) return;
      current.output = '';
      current.outputLoading = false;
    }
    this.refreshProps();
  }

  private refreshProps(): void {
    const browser = this.host.state.tasksBrowserMini;
    if (browser === undefined) return;
    browser.component.setProps({
      tasks: [...this.host.backgroundTasks.values()],
      tab: browser.tab,
      selectedTaskId: browser.selectedTaskId,
      height: Math.floor(this.host.state.terminal.rows * 0.5),
      output: browser.output,
      outputLoading: browser.outputLoading,
      activity: undefined,
      cwd: this.host.session?.workDir,
      flashMessage: browser.flashMessage,
      availableModels: this.host.state.appState.availableModels,
      onSelect: (taskId) => this.handleSelect(taskId),
      onTabChange: (tab) => this.handleTabChange(tab),
      onRefresh: () => this.handleRefresh(),
      onCancel: () => this.close(),
      onStop: (taskId) => void this.handleStop(taskId),
      onStopIgnored: () => {},
      onAmplify: () => this.amplify(),
    });
    this.host.state.ui.requestRender();
  }

  private amplify(): void {
    this.close();
    void this.host.tasksBrowserController.show();
  }

  private flash(message: string, durationMs = 2500): void {
    const browser = this.host.state.tasksBrowserMini;
    if (browser === undefined) return;
    if (browser.flashTimer !== undefined) clearTimeout(browser.flashTimer);
    browser.flashMessage = message;
    browser.flashTimer = setTimeout(() => {
      const current = this.host.state.tasksBrowserMini;
      if (current !== browser) return;
      current.flashMessage = undefined;
      current.flashTimer = undefined;
      this.refreshProps();
    }, durationMs);
    this.refreshProps();
  }
}