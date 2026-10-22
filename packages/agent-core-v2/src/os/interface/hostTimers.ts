import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface IHostTimerHandle {
  unref?(): void;
}

export interface IHostTimers {
  readonly _serviceBrand: undefined;

  setClampedTimeout(callback: () => void, timeoutMs: number): IHostTimerHandle;
  setTimeout(callback: () => void, timeoutMs: number): IHostTimerHandle;
  clearTimeout(handle: IHostTimerHandle): void;
}

export const IHostTimers: ServiceIdentifier<IHostTimers> = createDecorator<IHostTimers>('hostTimers');
