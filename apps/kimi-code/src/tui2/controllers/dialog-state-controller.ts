/**
 * TUI2 DialogStateController — modular management for modal dialog stacks.
 *
 * Owns opening, closing, cancelling, and applying results for all TUI2 dialogs:
 * ModelSelector, ThemeSelector, PermissionSelector, SettingsSelector,
 * TasksBrowser, GoalQueueManager, CodingPlanConfig, AgentActivityViewer, etc.
 *
 * Status: REAL (tui2). Modular dialog coordinator extracted from KimiTUI.
 */

import type { DialogDispatch, DialogKind, DialogResult } from '../dispatch';
import type { Tui2Store } from '../state';

export interface DialogHost {
  readonly store: Tui2Store;
  applyTheme?(name: string): Promise<void>;
  switchSession?(sessionId: string): Promise<void>;
  showError?(message: string): void;
}

export class DialogStateController implements DialogDispatch {
  constructor(private readonly host: DialogHost) {}

  get activeDialog(): DialogKind | null {
    return this.host.store.state.activeDialog as DialogKind | null;
  }

  isOpen(kind?: DialogKind): boolean {
    if (kind === undefined) return this.activeDialog !== null;
    return this.activeDialog === kind;
  }

  open(kind: DialogKind, payload?: Record<string, unknown>): void {
    if (payload) {
      this.host.store.patch(kind as never, payload as never);
    }
    this.host.store.setState('activeDialog', kind);
  }

  close(): void {
    this.host.store.setState('activeDialog', null);
  }

  cancel(kind?: DialogKind): void {
    if (kind === undefined || this.activeDialog === kind) {
      this.close();
    }
  }

  select(result: DialogResult): void {
    switch (result.kind) {
      case 'theme-selector':
        if (this.host.applyTheme) {
          void this.host.applyTheme(result.themeName);
        }
        this.close();
        break;
      case 'session-picker':
        if (this.host.switchSession) {
          void this.host.switchSession(result.sessionId);
        }
        this.close();
        break;
      default:
        this.close();
        break;
    }
  }
}
