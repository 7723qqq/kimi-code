import {
  Disposable,
} from "#/_base/di";
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import type { ContextMessage } from '#/contextMemory';
import { IContextMemory } from '#/contextMemory';
import { IEventSink } from '../eventSink';
import { ISubagentHost } from '#/subagentHost';
import { IToolRegistry } from '#/toolRegistry';
import { ITurnService } from '#/turn';
import { IWireRecord } from '#/wireRecord';
import SWARM_MODE_ENTER_REMINDER from './enter-reminder.md?raw';
import SWARM_MODE_EXIT_REMINDER from './exit-reminder.md?raw';
import { AgentSwarmTool } from './agent-swarm';
import {
  ISwarmService,
  type SwarmModeTrigger,
} from './swarm';

export interface SwarmServiceOptions {
  readonly registerAgentSwarmTool?: boolean;
}

export class SwarmService extends Disposable implements ISwarmService {
  declare readonly _serviceBrand: undefined;

  private _active: SwarmModeTrigger | null = null;

  constructor(
    options: SwarmServiceOptions = {},
    @IContextMemory private readonly context: IContextMemory,
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IEventSink private readonly events: IEventSink,
    @ITurnService turnService?: ITurnService,
    @IToolRegistry toolRegistry?: IToolRegistry,
    @ISubagentHost subagentHost?: ISubagentHost,
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
    if (turnService !== undefined) {
      this._register(
        turnService.hooks.onEnded.register('swarm-mode-auto-exit', (_ctx, next) => {
          const done = next();
          if (this.shouldAutoExit) {
            this.exit();
          }
          return done;
        }),
      );
    }
    if (options.registerAgentSwarmTool === true) {
      this._register(
        this.requireToolRegistry(toolRegistry).register(
          new AgentSwarmTool(this.requireSubagentHost(subagentHost), this),
        ),
      );
    }
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
      this.appendSystemReminder(SWARM_MODE_ENTER_REMINDER, 'swarm_mode');
    }
    this.emitChanged();
  }

  private applyExit(injectExitReminder: boolean): void {
    if (this._active === null) return;
    const trigger = this._active;
    this._active = null;
    const removedEnterReminder = trigger !== 'tool' && this.removeLastSwarmReminder();
    if (injectExitReminder && trigger !== 'tool' && !removedEnterReminder) {
      this.appendSystemReminder(SWARM_MODE_EXIT_REMINDER, 'swarm_mode_exit');
    }
    this.emitChanged();
  }

  private emitChanged(): void {
    this.events.emit({ type: 'agent.status.updated', swarmMode: this.isActive });
  }

  private requireToolRegistry(toolRegistry: IToolRegistry | undefined): IToolRegistry {
    if (toolRegistry !== undefined) return toolRegistry;
    throw new Error('AgentSwarm requires the agent tool registry service.');
  }

  private requireSubagentHost(subagentHost: ISubagentHost | undefined): ISubagentHost {
    if (subagentHost !== undefined) return subagentHost;
    throw new Error('AgentSwarm requires the agent subagent host service.');
  }

  private appendSystemReminder(content: string, variant: string): void {
    const message: ContextMessage = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `<system-reminder>\n${content.trim()}\n</system-reminder>`,
        },
      ],
      toolCalls: [],
      origin: {
        kind: 'injection',
        variant,
      },
    };
    this.context.splice(this.context.get().length, 0, [message]);
  }

  private removeLastSwarmReminder(): boolean {
    const history = this.context.get();
    const lastIndex = history.length - 1;
    const last = history[lastIndex];
    if (last?.origin?.kind !== 'injection') return false;
    if (last.origin.variant !== 'swarm_mode') return false;
    this.context.splice(lastIndex, 1, []);
    return true;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  ISwarmService,
  SwarmService,
  InstantiationType.Delayed,
  'swarm',
);
