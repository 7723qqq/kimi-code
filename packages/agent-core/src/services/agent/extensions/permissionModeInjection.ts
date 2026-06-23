import type { PermissionMode } from '../../../agent/permission';
import { Disposable } from '../../../di';
import { IDynamicInjector } from '../dynamicInjector/dynamicInjector';
import AUTO_MODE_ENTER_REMINDER from './permission-mode-auto-enter-reminder.md?raw';
import AUTO_MODE_EXIT_REMINDER from './permission-mode-auto-exit-reminder.md?raw';

export class PermissionModeInjection extends Disposable {
  private currentMode: PermissionMode = 'manual';
  private lastMode: PermissionMode | undefined;

  constructor(
    @IDynamicInjector dynamicInjector: IDynamicInjector,
  ) {
    super();
    this._register(
      dynamicInjector.register('permission_mode', () => this.reminder()),
    );
  }

  get mode(): PermissionMode {
    return this.currentMode;
  }

  setMode(mode: PermissionMode): void {
    this.currentMode = mode;
  }

  private reminder(): string | undefined {
    const previousMode = this.lastMode;
    if (this.currentMode === previousMode) return undefined;

    this.lastMode = this.currentMode;
    if (this.currentMode === 'auto') return AUTO_MODE_ENTER_REMINDER;
    if (previousMode === 'auto') return AUTO_MODE_EXIT_REMINDER;
    return undefined;
  }
}
