import { Service } from '#/_base/di/service';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentStateService } from '#/agent/state/agentState';
import type { IAgentReminderService } from '#/features/reminder/reminderService';
import { IAgentSpecService } from '#/features/spec/spec';
import { defineState } from '#/state/state';

import SPEC_MODE_EXIT_REMINDER from './spec-mode-exit-reminder.md?raw';
import SPEC_MODE_FULL_REMINDER from './spec-mode-full-reminder.md?raw';
import SPEC_MODE_REENTRY_REMINDER from './spec-mode-reentry-reminder.md?raw';
import SPEC_MODE_SPARSE_REMINDER from './spec-mode-sparse-reminder.md?raw';

const SPEC_MODE_DEDUP_MIN_TURNS = 2;
const SPEC_MODE_FULL_REFRESH_TURNS = 5;
const SPEC_MODE_INJECTION_VARIANT = 'spec_mode';

export const specWasActiveKey = defineState<boolean>('spec.wasActive', () => false);

export class SpecModeInjection extends Service {
  constructor(
    injector: IAgentReminderService,
    @IAgentSpecService private readonly spec: IAgentSpecService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.contributeState(specWasActiveKey);

    this._register(
      injector.register(SPEC_MODE_INJECTION_VARIANT, async ({ lastInjectedAt: injectedAt }) => {
        const data = await this.spec.status();
        if (data === null) {
          if (!this.states.get(specWasActiveKey)) return undefined;
          this.states.set(specWasActiveKey, false);
          return SPEC_MODE_EXIT_REMINDER;
        }
        const specDir = data.dir;
        if (!this.states.get(specWasActiveKey)) {
          this.states.set(specWasActiveKey, true);
          const hasContent = Object.values(data.files).some((content) => content.trim().length > 0);
          return withSpecDirFooter(
            hasContent ? SPEC_MODE_REENTRY_REMINDER : SPEC_MODE_FULL_REMINDER,
            specDir,
          );
        }
        const variant = specModeReminderVariant(injectedAt, this.context.get());
        if (variant === 'full') return withSpecDirFooter(SPEC_MODE_FULL_REMINDER, specDir);
        if (variant === 'sparse') return withSpecDirFooter(SPEC_MODE_SPARSE_REMINDER, specDir);
        return undefined;
      }),
    );
  }
}

type SpecModeReminderVariant = 'full' | 'sparse';

function specModeReminderVariant(
  injectedAt: number | null,
  history: readonly ContextMessage[],
): SpecModeReminderVariant | null {
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
  if (assistantTurnsSince >= SPEC_MODE_FULL_REFRESH_TURNS) return 'full';
  if (assistantTurnsSince >= SPEC_MODE_DEDUP_MIN_TURNS) return 'sparse';
  return null;
}

function withSpecDirFooter(body: string, specDir: string): string {
  if (specDir.length === 0) return body;
  return `${body}\n\nSpec directory: ${specDir}`;
}
