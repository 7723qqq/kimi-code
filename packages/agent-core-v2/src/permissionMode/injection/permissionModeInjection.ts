import type { PermissionMode } from '#/permissionPolicy';
import type { IDisposable } from "#/_base/di";
import type { IAgentContextInjectorService } from '../../contextInjector/contextInjector';
import type { IAgentPermissionModeService } from '../permissionMode';
import AUTO_MODE_ENTER_REMINDER from './permission-mode-auto-enter-reminder.md?raw';
import AUTO_MODE_EXIT_REMINDER from './permission-mode-auto-exit-reminder.md?raw';

const PERMISSION_MODE_INJECTION_VARIANT = 'permission_mode';

export function registerPermissionModeInjection(
  dynamicInjector: IAgentContextInjectorService,
  permissionMode: Pick<IAgentPermissionModeService, 'mode'>,
): IDisposable {
  let lastMode: PermissionMode | undefined;
  return dynamicInjector.register(PERMISSION_MODE_INJECTION_VARIANT, () => {
    const previousMode = lastMode;
    const currentMode = permissionMode.mode;
    if (currentMode === previousMode) return undefined;

    lastMode = currentMode;
    if (currentMode === 'auto') return AUTO_MODE_ENTER_REMINDER;
    if (previousMode === 'auto') return AUTO_MODE_EXIT_REMINDER;
    return undefined;
  });
}

export { registerPermissionModeInjection as PermissionModeInjection };
