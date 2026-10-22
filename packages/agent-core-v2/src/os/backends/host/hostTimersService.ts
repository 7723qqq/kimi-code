import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { setClampedTimeout } from '#/_base/utils/timer';
import { LifecycleScope } from '#/app/scopes';
import { IHostTimers, type IHostTimerHandle } from '#/os/interface/hostTimers';

function unrefTimer(handle: IHostTimerHandle): IHostTimerHandle {
  handle.unref?.();
  return handle;
}

export class HostTimersService implements IHostTimers {
  declare readonly _serviceBrand: undefined;

  setClampedTimeout(callback: () => void, timeoutMs: number): IHostTimerHandle {
    return unrefTimer(setClampedTimeout(callback, timeoutMs));
  }

  setTimeout(callback: () => void, timeoutMs: number): IHostTimerHandle {
    return unrefTimer(globalThis.setTimeout(callback, timeoutMs));
  }

  clearTimeout(handle: IHostTimerHandle): void {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  }
}

registerScopedService(
  LifecycleScope.App,
  IHostTimers,
  HostTimersService,
  ScopeActivation.OnScopeCreated,
  'hostTimers',
);
