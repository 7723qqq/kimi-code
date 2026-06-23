import { Disposable } from '../../../di';

import { IContextMemory } from '../contextMemory/contextMemory';
import { IDynamicInjector } from '../dynamicInjector/dynamicInjector';
import { IEventBus } from '../eventBus/eventBus';
import { IToolRegistry } from '../toolRegistry/toolRegistry';
import { IWireRecord } from '../wireRecord/wireRecord';

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
      dynamicInjector.register(({ injectedAt }) => {
        if (!this.active) {
          if (!wasActive) return undefined;
          wasActive = false;
          return PLAN_MODE_EXIT_REMINDER;
        }
        if (!wasActive) {
          wasActive = true;
          return PLAN_MODE_ENTER_REMINDER;
        }
        if (injectedAt === null && this.context.getHistory().length > 0) {
          return PLAN_MODE_ENTER_REMINDER;
        }
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

const PLAN_MODE_ENTER_REMINDER =
  'Plan mode is active. Prefer read-only investigation and write the plan before exiting plan mode.';

const PLAN_MODE_EXIT_REMINDER =
  'Plan mode is no longer active. Continue with the approved plan using normal tool and permission rules.';
