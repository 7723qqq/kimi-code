import type { BackgroundTaskInfo, Session } from '@moonshot-ai/kimi-code-sdk';
import type { Component, TUI } from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';

export interface TaskPanelState {
  flashMessage: string | undefined;
  flashTimer: NodeJS.Timeout | undefined;
  pollTimer: NodeJS.Timeout | undefined;
}

export abstract class TaskPanelController<State extends TaskPanelState> {
  private refreshing = false;

  protected abstract get panelState(): State | undefined;
  protected abstract get session(): Session | undefined;
  protected abstract get ui(): TUI;
  protected abstract repaint(): void;
  protected abstract applyTasks(
    state: State,
    tasks: readonly BackgroundTaskInfo[],
    session: Session,
  ): Promise<void> | void;

  protected activatePanel(component: Component): NodeJS.Timeout {
    this.ui.setFocus(component);
    this.ui.requestRender(true);
    return setInterval(() => {
      void this.refresh({ silent: true });
    }, 1000);
  }

  protected deactivatePanel(state: State): void {
    if (state.pollTimer !== undefined) clearInterval(state.pollTimer);
    if (state.flashTimer !== undefined) clearTimeout(state.flashTimer);
  }

  protected async refresh(opts: { silent?: boolean } = {}): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const state = this.panelState;
      if (state === undefined) return;
      const session = this.session;
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
      if (this.panelState !== state) return;
      await this.applyTasks(state, tasks, session);
    } finally {
      this.refreshing = false;
    }
  }

  protected flash(message: string, durationMs = 2500): void {
    const state = this.panelState;
    if (state === undefined) return;
    if (state.flashTimer !== undefined) clearTimeout(state.flashTimer);
    state.flashMessage = message;
    state.flashTimer = setTimeout(() => {
      const current = this.panelState;
      if (current !== state) return;
      current.flashMessage = undefined;
      current.flashTimer = undefined;
      this.repaint();
    }, durationMs);
    this.repaint();
  }
}
