/**
 * `swarm` domain (L4) — `IAgentSwarmService` implementation.
 *
 * Tracks swarm-mode enter/exit (mirroring it into `wireRecord` and
 * `systemReminder`), auto-exits on turn end, and registers the `AgentSwarm`
 * tool bound to this agent as the parent. Bound at Agent scope; spawns child
 * agents through `agent-lifecycle`, reads its identity through `scopeContext`,
 * and registers the tool through `toolRegistry`.
 */

import { Disposable } from '#/_base/di';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentRecordService } from '#/agent/record';
import { IAgentScopeContext } from '#/agent/scopeContext';
import { IAgentSystemReminderService } from '#/agent/systemReminder';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import { IAgentTurnService } from '#/agent/turn';
import { IAgentLifecycleService } from '#/session/agent-lifecycle';
import SWARM_MODE_ENTER_REMINDER from './enter-reminder.md?raw';
import SWARM_MODE_EXIT_REMINDER from './exit-reminder.md?raw';
import { AgentSwarmTool, type AgentSwarmToolHost } from '#/agent/swarm/tools/agent-swarm';
import {
  IAgentSwarmService,
  type SwarmModeTrigger,
} from './swarm';

declare module '#/agent/wireRecord' {
  interface WireRecordMap {
    'swarm_mode.enter': {
      trigger: SwarmModeTrigger;
    };
    'swarm_mode.exit': {};
  }
}

export class AgentSwarmService extends Disposable implements IAgentSwarmService {
  declare readonly _serviceBrand: undefined;

  private _active: SwarmModeTrigger | null = null;

  constructor(
    runQueued: AgentSwarmToolHost['runQueued'] | undefined,
    @IAgentRecordService private readonly record: IAgentRecordService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IAgentTurnService turnService: IAgentTurnService,
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
    @IAgentLifecycleService lifecycle: IAgentLifecycleService,
    @IAgentScopeContext ctx: IAgentScopeContext,
  ) {
    super();
    this._register(
      record.define('swarm_mode.enter', {
        resume: (r) => {
          this.restoreEnter(r.trigger);
        },
      }),
    );
    this._register(
      record.define('swarm_mode.exit', {
        resume: () => {
          this.applyExit(false);
        },
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
    this._register(
      toolRegistry.register(
        new AgentSwarmTool({ lifecycle, parentAgentId: ctx.agentId, runQueued }, this),
      ),
    );
  }

  enter(trigger: SwarmModeTrigger): void {
    if (this._active !== null) return;
    this.record.append({ type: 'swarm_mode.enter', trigger });
    this.applyEnter(trigger, true);
  }

  exit(): void {
    if (this._active === null) return;
    this.record.append({ type: 'swarm_mode.exit' });
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
    this.record.signal({ type: 'agent.status.updated', swarmMode: this.isActive });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentSwarmService,
  AgentSwarmService,
  InstantiationType.Delayed,
  'swarm',
);
