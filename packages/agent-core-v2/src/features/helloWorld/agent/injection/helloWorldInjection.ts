import { Disposable } from '#/_base/di/lifecycle';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { IAgentReminderService } from '#/features/reminder/reminderService';
import type { ContextInjectionContext, ContextInjectionResult } from '#/features/reminder/types';

import HELLO_WORLD_MODE_ENTER_REMINDER from '../enter-reminder.md?raw';
import HELLO_WORLD_MODE_EXIT_REMINDER from '../exit-reminder.md?raw';
import type {
  HelloWorldModeTrigger,
  HelloWorldRunItem,
  HelloWorldRunState,
  HelloWorldStage,
} from '../helloWorld';
import DELIVER_STAGE_SCRIPT from '../stages/deliver.md?raw';
import DESIGN_STAGE_SCRIPT from '../stages/design.md?raw';
import DOCS_STAGE_SCRIPT from '../stages/docs.md?raw';
import IMPLEMENT_STAGE_SCRIPT from '../stages/implement.md?raw';
import REQUIREMENTS_STAGE_SCRIPT from '../stages/requirements.md?raw';
import REVIEW_STAGE_SCRIPT from '../stages/review.md?raw';
import TEST_STAGE_SCRIPT from '../stages/test.md?raw';

const HELLO_WORLD_MODE_INJECTION_VARIANT = 'hello_world_mode';

const HELLO_WORLD_STAGE_SCRIPTS: Record<HelloWorldStage, string> = {
  requirements: REQUIREMENTS_STAGE_SCRIPT,
  design: DESIGN_STAGE_SCRIPT,
  implement: IMPLEMENT_STAGE_SCRIPT,
  test: TEST_STAGE_SCRIPT,
  review: REVIEW_STAGE_SCRIPT,
  docs: DOCS_STAGE_SCRIPT,
  deliver: DELIVER_STAGE_SCRIPT,
};

interface HelloWorldModeInjectionDisclosure {
  readonly kind: 'hello_world_mode';
  readonly state: 'active' | 'inactive';
  readonly stage: HelloWorldStage;
}

export interface HelloWorldInjectionOptions {
  readonly getTrigger: () => HelloWorldModeTrigger | null;
  readonly getRun: () => HelloWorldRunState | null;
}

export class HelloWorldInjection extends Disposable {
  constructor(
    private readonly options: HelloWorldInjectionOptions,
    injector: IAgentReminderService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
  ) {
    super();
    this._register(
      injector.register<HelloWorldModeInjectionDisclosure>(
        HELLO_WORLD_MODE_INJECTION_VARIANT,
        (ctx) => this.reminder(ctx),
      ),
    );
  }

  private reminder(
    ctx: ContextInjectionContext<HelloWorldModeInjectionDisclosure>,
  ): ContextInjectionResult<HelloWorldModeInjectionDisclosure> | undefined {
    const trigger = this.options.getTrigger();
    const run = this.options.getRun();
    const last = this.renderedDisclosure(ctx);
    if (run !== null && trigger !== null && trigger !== 'tool') {
      const stage = run.stage;
      if (last !== undefined && last.state === 'active' && last.stage === stage) return undefined;
      const opening =
        last !== undefined && last.state === 'active'
          ? ''
          : `${HELLO_WORLD_MODE_ENTER_REMINDER}\n\n`;
      return {
        content: `${runStatusBlock(run)}\n\n${opening}${HELLO_WORLD_STAGE_SCRIPTS[stage]}`,
        disclosure: { kind: 'hello_world_mode', state: 'active', stage },
      };
    }
    if (trigger !== null) return undefined;
    if (last === undefined || last.state !== 'active') return undefined;
    return {
      content: HELLO_WORLD_MODE_EXIT_REMINDER,
      disclosure: { kind: 'hello_world_mode', state: 'inactive', stage: last.stage },
    };
  }

  private renderedDisclosure(
    ctx: ContextInjectionContext<HelloWorldModeInjectionDisclosure>,
  ): HelloWorldModeInjectionDisclosure | undefined {
    if (ctx.lastDisclosure !== undefined) return ctx.lastDisclosure;
    const history = this.context.get();
    for (let i = history.length - 1; i >= 0; i--) {
      const origin = history[i]!.origin;
      if (origin?.kind !== 'injection') continue;
      if (origin.variant === HELLO_WORLD_MODE_INJECTION_VARIANT) {
        return { kind: 'hello_world_mode', state: 'active', stage: 'requirements' };
      }
    }
    return undefined;
  }
}

function runStatusBlock(run: HelloWorldRunState): string {
  const lines = [
    '## Run State',
    `Task: ${run.task ?? '(not recorded)'}`,
    `Stage: ${run.stage}`,
    'Checklist:',
    ...run.items.map((item) => checklistLine(item)),
  ];
  if (run.waivers.length > 0) lines.push(`Waived: ${run.waivers.join(', ')}`);
  return lines.join('\n');
}

function checklistLine(item: HelloWorldRunItem): string {
  const mark = item.done ? 'x' : ' ';
  const evidence = item.evidence === undefined ? '' : ` — ${item.evidence}`;
  return `- [${mark}] ${item.id}${evidence}`;
}
