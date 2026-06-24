import SWARM_MODE_ENTER_REMINDER from '../../../agent/swarm/enter-reminder.md?raw';
import SWARM_MODE_EXIT_REMINDER from '../../../agent/swarm/exit-reminder.md?raw';
import { Disposable, IInstantiationService } from '../../../di';
import {
  AgentSwarmTool,
  type AgentSwarmSubagentHost,
} from '../../../tools/builtin/collaboration/agent-swarm';

import { IContextMemory } from '../contextMemory/contextMemory';
import { IEventBus } from '../eventBus/eventBus';
import { IToolRegistry } from '../toolRegistry/toolRegistry';
import { ITurnRunner } from '../turnRunner/turnRunner';
import type { ContextMessage } from '../types';
import { IWireRecord } from '../wireRecord/wireRecord';

export type SwarmModeTrigger = 'manual' | 'task' | 'tool';

export interface SwarmModeOptions {
  readonly subagentHost?: AgentSwarmSubagentHost;
}

declare module '../types' {
  interface WireRecordMap {
    'swarm_mode.enter': {
      trigger: SwarmModeTrigger;
    };
    'swarm_mode.exit': {};
  }

  interface AgentEventMap {
    'swarm_mode.changed': {
      active: SwarmModeTrigger | null;
    };
  }
}

export class SwarmMode extends Disposable {
  private _active: SwarmModeTrigger | null = null;

  constructor(
    private readonly options: SwarmModeOptions = {},
    @IContextMemory private readonly context: IContextMemory,
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IEventBus private readonly events: IEventBus,
    @ITurnRunner turnRunner?: ITurnRunner,
    @IInstantiationService private readonly instantiation?: IInstantiationService,
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
    if (turnRunner !== undefined) {
      this._register(
        turnRunner.hooks.onEnded.register('swarm-mode-auto-exit', async (_ctx, next) => {
          await next();
          if (this.shouldAutoExit) {
            this.exit();
          }
        }),
      );
    }
    if (options.subagentHost !== undefined) {
      this._register(
        this.resolveToolRegistry().register(new AgentSwarmTool(options.subagentHost, this)),
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

  restoreEnter(trigger: SwarmModeTrigger): void {
    this.applyEnter(trigger, false);
  }

  data(): boolean {
    return this.isActive;
  }

  get active(): SwarmModeTrigger | null {
    return this._active;
  }

  get isActive(): boolean {
    return this._active !== null;
  }

  get shouldAutoExit(): boolean {
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
    if (injectExitReminder && trigger !== 'tool' && !this.removeLastSwarmReminder()) {
      this.appendSystemReminder(SWARM_MODE_EXIT_REMINDER, 'swarm_mode_exit');
    }
    this.emitChanged();
  }

  private emitChanged(): void {
    this.events.emit({ type: 'swarm_mode.changed', active: this._active });
    this.events.emit({ type: 'agent.status.updated', swarmMode: this.isActive });
  }

  private resolveToolRegistry(): IToolRegistry {
    try {
      const toolRegistry = this.instantiation?.invokeFunction((accessor) =>
        accessor.get(IToolRegistry),
      );
      if (toolRegistry !== undefined) return toolRegistry;
    } catch (error) {
      void error;
    }
    throw new Error('AgentSwarm requires the agent tool registry service.');
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
    this.context.spliceHistory(this.context.getHistory().length, 0, message);
  }

  private removeLastSwarmReminder(): boolean {
    const history = this.context.getHistory();
    for (let index = history.length - 1; index >= 0; index--) {
      const message = history[index];
      if (message?.origin?.kind !== 'injection') continue;
      if (message.origin.variant !== 'swarm_mode') continue;
      this.context.spliceHistory(index, 1);
      return true;
    }
    return false;
  }
}
