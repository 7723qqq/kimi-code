import type { PermissionMode } from '../../../agent/permission';
import { Disposable, registerSingleton, SyncDescriptor } from '../../../di';

import { IDynamicInjector } from '../dynamicInjector/dynamicInjector';
import { IEventBus } from '../eventBus/eventBus';
import { OrderedHookSlot } from '../hooks';
import { IReplayBuilderService } from '../replayBuilder/replayBuilder';
import type { WireRecord } from '../types';
import { IWireRecord } from '../wireRecord/wireRecord';
import AUTO_MODE_ENTER_REMINDER from '../extensions/permission-mode-auto-enter-reminder.md?raw';
import AUTO_MODE_EXIT_REMINDER from '../extensions/permission-mode-auto-exit-reminder.md?raw';
import { IPermissionModeService } from './permissionMode';

declare module '../types' {
  interface WireRecordMap {
    'permission.set_mode': {
      mode: PermissionMode;
    };
  }

  interface AgentEventMap {
    'permission.mode.changed': {
      mode: PermissionMode;
      previousMode: PermissionMode;
    };
  }
}

const PERMISSION_MODE_INJECTION_VARIANT = 'permission_mode';

export class PermissionModeService extends Disposable implements IPermissionModeService {
  private currentMode: PermissionMode = 'manual';
  private lastInjectedMode: PermissionMode | undefined;

  readonly hooks = {
    onChanged: new OrderedHookSlot<{
      mode: PermissionMode;
      previousMode: PermissionMode;
    }>(),
  };

  constructor(
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IEventBus private readonly events: IEventBus,
    @IReplayBuilderService private readonly replayBuilder: IReplayBuilderService,
    @IDynamicInjector dynamicInjector: IDynamicInjector,
  ) {
    super();
    this._register(
      wireRecord.register('permission.set_mode', (record) => {
        this.applyMode(record);
      }),
    );
    this._register(
      dynamicInjector.register(PERMISSION_MODE_INJECTION_VARIANT, () => this.autoModeReminder()),
    );
  }

  get mode(): PermissionMode {
    return this.currentMode;
  }

  setMode(mode: PermissionMode): void {
    this.wireRecord.append({ type: 'permission.set_mode', mode });
    this.applyMode({ type: 'permission.set_mode', mode });
  }

  private applyMode(record: WireRecord<'permission.set_mode'>): void {
    this.replayBuilder.push({ type: 'permission_updated', mode: record.mode });
    const previousMode = this.currentMode;
    this.currentMode = record.mode;
    this.events.emit({
      type: 'permission.mode.changed',
      mode: this.currentMode,
      previousMode,
    });
    this.events.emit({
      type: 'agent.status.updated',
      permission: this.currentMode,
    });
    void this.hooks.onChanged.run({ mode: this.currentMode, previousMode });
  }

  private autoModeReminder(): string | undefined {
    const previousMode = this.lastInjectedMode;
    if (this.currentMode === previousMode) return undefined;

    this.lastInjectedMode = this.currentMode;
    if (this.currentMode === 'auto') return AUTO_MODE_ENTER_REMINDER;
    if (previousMode === 'auto') return AUTO_MODE_EXIT_REMINDER;
    return undefined;
  }
}

registerSingleton(
  IPermissionModeService,
  new SyncDescriptor(PermissionModeService, [], true),
);
