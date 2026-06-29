import {
  Disposable,
} from "#/_base/di";
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IEventSink } from '../eventSink';
import { ISubagentHost } from '#/subagentHost';
import { ISystemReminderService } from '#/systemReminder';
import { IToolRegistry } from '#/toolRegistry';
import { ITurnService } from '#/turn';
import { IWireRecord } from '#/wireRecord';
import SWARM_MODE_ENTER_REMINDER from './enter-reminder.md?raw';
import SWARM_MODE_EXIT_REMINDER from './exit-reminder.md?raw';
import { AgentSwarmTool } from './tools/agent-swarm';
import {
  ISwarmService,
  type SwarmModeTrigger,
} from './swarm';

declare module '#/wireRecord' {
  interface WireRecordMap {
    'swarm_mode.enter': {
      trigger: SwarmModeTrigger;
    };
    'swarm_mode.exit': {};
  }
}

export class SwarmService extends Disposable implements ISwarmService {
  declare readonly _serviceBrand: undefined;

  private _active: SwarmModeTrigger | null = null;

  constructor(
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IEventSink private readonly events: IEventSink,
    @ISystemReminderService private readonly reminders: ISystemReminderService,
    @ITurnService turnService: ITurnService,
    @IToolRegistry toolRegistry: IToolRegistry,
    @ISubagentHost subagentHost: ISubagentHost,
  ) {
    super();
    this._register(
      wireRecord.register('swarm_mode.enter', (record) => {
        this.restoreEnter(record.trigger);
      }),
    );
    this._register(
      wireRecord.register('swarm_mode.exit', () => {
        this.applyExit(false);
      }),
    );
    this._register(
      turnService.hooks.onEnded.register('swarm-mode-auto-exit', (_ctx, next) => {
        const done = next();
        if (this.shouldAutoExit) {
          this.exit();
        }
        return done;
      }),
    );
    this._register(toolRegistry.register(new AgentSwarmTool(subagentHost, this)));
  }

  enter(trigger: SwarmModeTrigger): void {
    if (this._active !== null) return;
    this.wireRecord.append({ type: 'swarm_mode.enter', trigger });
    this.applyEnter(trigger, true);
  }

  exit(): void {
    if (this._active === null) return;
    this.wireRecord.append({ type: 'swarm_mode.exit' });
    this.applyExit(true);
  }

  get isActive(): boolean {
    return this._active !== null;
  }

  private restoreEnter(trigger: SwarmModeTrigger): void {
    this.applyEnter(trigger, false);
  }

  private get shouldAutoExit(): boolean {
    return this._active === 'task' || this._active === 'tool';
  }

  private applyEnter(trigger: SwarmModeTrigger, injectReminder: boolean): void {
    if (this._active !== null) return;
    this._active = trigger;
    if (injectReminder && trigger !== 'tool') {
      this.reminders.appendSystemReminder(SWARM_MODE_ENTER_REMINDER, { kind: 'injection', variant: 'swarm_mode' });
    }
    this.emitChanged();
  }

  private applyExit(injectExitReminder: boolean): void {
    if (this._active === null) return;
    const trigger = this._active;
    this._active = null;
    const removedEnterReminder = trigger !== 'tool' && this.reminders.removeLastReminder(
      (m) => m.origin?.kind === 'injection' && m.origin.variant === 'swarm_mode',
    );
    if (injectExitReminder && trigger !== 'tool' && !removedEnterReminder) {
      this.reminders.appendSystemReminder(SWARM_MODE_EXIT_REMINDER, { kind: 'injection', variant: 'swarm_mode_exit' });
    }
    this.emitChanged();
  }

  private emitChanged(): void {
    this.events.emit({ type: 'agent.status.updated', swarmMode: this.isActive });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  ISwarmService,
  SwarmService,
  InstantiationType.Delayed,
  'swarm',
);
