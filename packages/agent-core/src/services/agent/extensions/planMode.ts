import { Disposable } from '../../../di';

import { IContextMemory } from '../contextMemory/contextMemory';
import { IDynamicInjector } from '../dynamicInjector/dynamicInjector';
import { IEventBus } from '../eventBus/eventBus';
import { IToolRegistry } from '../toolRegistry/toolRegistry';
import type { ContextMessage } from '../types';
import { IWireRecord } from '../wireRecord/wireRecord';
import PLAN_MODE_EXIT_REMINDER from './plan-mode-exit-reminder.md?raw';
import PLAN_MODE_FULL_REMINDER from './plan-mode-full-reminder.md?raw';
import PLAN_MODE_SPARSE_REMINDER from './plan-mode-sparse-reminder.md?raw';

declare module '../types' {
  interface WireRecordMap {
    'plan_mode_change': {
      isActive: boolean;
    };
  }

  interface AgentEventMap {
    'plan_mode.changed': {
      isActive: boolean;
    };
  }
}

const PLAN_MODE_DEDUP_MIN_TURNS = 2;
const PLAN_MODE_FULL_REFRESH_TURNS = 5;
const PLAN_MODE_INJECTION_VARIANT = 'plan_mode';

export class PlanMode extends Disposable {
  private _active = false;

  constructor(
    @IContextMemory private readonly context: IContextMemory,
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IEventBus private readonly events: IEventBus,
    @IToolRegistry toolRegistry: IToolRegistry,
    @IDynamicInjector dynamicInjector: IDynamicInjector,
  ) {
    super();
    this._register(
      wireRecord.register('plan_mode_change', ({ isActive }) => {
        this._active = isActive;
      }),
    );

    this._register(
      toolRegistry.register({
        name: 'EnterPlanMode',
        description: 'Enter plan mode.',
        execute: async () => {
          this.active = true;
          return { output: 'Plan mode entered.' };
        },
      }),
    );
    this._register(
      toolRegistry.register({
        name: 'ExitPlanMode',
        description: 'Exit plan mode.',
        execute: async () => {
          this.active = false;
          return { output: 'Plan mode exited.' };
        },
      }),
    );

    let wasActive = false;
    this._register(
      dynamicInjector.register(PLAN_MODE_INJECTION_VARIANT, ({ injectedAt }) => {
        if (!this.active) {
          if (!wasActive) return undefined;
          wasActive = false;
          return PLAN_MODE_EXIT_REMINDER;
        }
        if (!wasActive) {
          wasActive = true;
          return PLAN_MODE_FULL_REMINDER;
        }
        const variant = planModeReminderVariant(injectedAt, this.context.getHistory());
        if (variant === 'full') return PLAN_MODE_FULL_REMINDER;
        if (variant === 'sparse') return PLAN_MODE_SPARSE_REMINDER;
        return undefined;
      }),
    );
  }

  get active(): boolean {
    return this._active;
  }

  enter(): void {
    this.active = true;
  }

  exit(): void {
    this.active = false;
  }

  set active(value: boolean) {
    if (this._active === value) return;
    this.wireRecord.append({ type: 'plan_mode_change', isActive: value });
    this._active = value;
    this.events.emit({ type: 'plan_mode.changed', isActive: value });
  }
}

type PlanModeReminderVariant = 'full' | 'sparse';

function planModeReminderVariant(
  injectedAt: number | null,
  history: readonly ContextMessage[],
): PlanModeReminderVariant | null {
  if (injectedAt === null) return 'full';
  let assistantTurnsSince = 0;
  for (let i = injectedAt + 1; i < history.length; i++) {
    const message = history[i];
    if (message === undefined) continue;
    if (message.role === 'assistant') {
      assistantTurnsSince += 1;
      continue;
    }
    if (message.role === 'user') {
      return 'full';
    }
  }
  if (assistantTurnsSince >= PLAN_MODE_FULL_REFRESH_TURNS) return 'full';
  if (assistantTurnsSince >= PLAN_MODE_DEDUP_MIN_TURNS) return 'sparse';
  return null;
}
