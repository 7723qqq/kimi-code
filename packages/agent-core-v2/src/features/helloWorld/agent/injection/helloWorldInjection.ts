import { Disposable } from '#/_base/di/lifecycle';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { IAgentReminderService } from '#/features/reminder/reminderService';
import type { ContextInjectionContext, ContextInjectionResult } from '#/features/reminder/types';

import HELLO_WORLD_MODE_ENTER_REMINDER from '../enter-reminder.md?raw';
import HELLO_WORLD_MODE_EXIT_REMINDER from '../exit-reminder.md?raw';
import type { HelloWorldModeTrigger } from '../helloWorld';

const HELLO_WORLD_MODE_INJECTION_VARIANT = 'hello_world_mode';

interface HelloWorldModeInjectionDisclosure {
  readonly kind: 'hello_world_mode';
  readonly state: 'active' | 'inactive';
}

export interface HelloWorldInjectionOptions {
  readonly getTrigger: () => HelloWorldModeTrigger | null;
}

export class HelloWorldInjection extends Disposable {
  constructor(
    private readonly options: HelloWorldInjectionOptions,
    injector: IAgentReminderService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
  ) {
    super();
    this._register(
      injector.register<HelloWorldModeInjectionDisclosure>(HELLO_WORLD_MODE_INJECTION_VARIANT, (ctx) =>
        this.reminder(ctx),
      ),
    );
  }

  private reminder(
    ctx: ContextInjectionContext<HelloWorldModeInjectionDisclosure>,
  ): ContextInjectionResult<HelloWorldModeInjectionDisclosure> | undefined {
    const trigger = this.options.getTrigger();
    const active = trigger !== null && trigger !== 'tool';
    const rendered = this.renderedState(ctx);
    if (active) {
      return rendered === 'active'
        ? undefined
        : {
            content: HELLO_WORLD_MODE_ENTER_REMINDER,
            disclosure: { kind: 'hello_world_mode', state: 'active' },
          };
    }
    return rendered === 'active'
      ? {
          content: HELLO_WORLD_MODE_EXIT_REMINDER,
          disclosure: { kind: 'hello_world_mode', state: 'inactive' },
        }
      : undefined;
  }

  private renderedState(
    ctx: ContextInjectionContext<HelloWorldModeInjectionDisclosure>,
  ): 'active' | 'inactive' | undefined {
    if (ctx.lastDisclosure !== undefined) return ctx.lastDisclosure.state;
    const history = this.context.get();
    for (let i = history.length - 1; i >= 0; i--) {
      const origin = history[i]!.origin;
      if (origin?.kind !== 'injection') continue;
      if (origin.variant === HELLO_WORLD_MODE_INJECTION_VARIANT) return 'active';
    }
    return undefined;
  }
}
