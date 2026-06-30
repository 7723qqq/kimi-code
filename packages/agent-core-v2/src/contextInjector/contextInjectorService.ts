import {
  Disposable,
  toDisposable,
} from "#/_base/di";
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { IAgentContextMemoryService } from '../contextMemory';
import { IAgentSystemReminderService } from '../systemReminder';
import { IAgentTurnService } from '../turn';
import type { ContextMessage } from '#/contextMemory';
import {
  IAgentContextInjectorService,
  type ContextInjectionOptions,
  type ContextInjectionProvider,
} from './contextInjector';

interface ContextInjectionEntry {
  readonly cadence: ContextInjectionOptions['cadence'];
  readonly provider: ContextInjectionProvider;
  readonly variant: string;
  injectedAt: number | null;
  resolveHistory: boolean;
  turnConsumed: boolean;
}

export class AgentContextInjectorService extends Disposable implements IAgentContextInjectorService {
  declare readonly _serviceBrand: undefined;
  private readonly entries = new Set<ContextInjectionEntry>();
  private readonly selfInsertedMessages = new WeakMap<ContextMessage, ContextInjectionEntry>();

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentTurnService turnService: IAgentTurnService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
  ) {
    super();
    this._register(
      turnService.hooks.beforeStep.register('context-injector', async (_ctx, next) => {
        await next();
        await this.inject();
      }),
    );
    this._register(
      turnService.hooks.onLaunched.register('context-injector', (_ctx, next) => {
        for (const entry of this.entries) {
          if (entry.cadence !== 'turn') continue;
          entry.injectedAt = null;
          entry.resolveHistory = false;
          entry.turnConsumed = false;
        }
        return next();
      }),
    );
    context.hooks.onSpliced.register('context-injector', (ctx, next) => {
      this.handleSplice(ctx);
      return next();
    });
  }

  register(
    variant: string,
    provider: ContextInjectionProvider,
    options: ContextInjectionOptions = {},
  ) {
    const entry: ContextInjectionEntry = {
      cadence: options.cadence ?? 'step',
      provider,
      variant,
      injectedAt: null,
      resolveHistory: true,
      turnConsumed: false,
    };
    this.entries.add(entry);
    return toDisposable(() => {
      this.entries.delete(entry);
    });
  }

  private async inject(): Promise<void> {
    for (const entry of this.entries) {
      const history = this.context.get();
      if (entry.resolveHistory) {
        entry.injectedAt ??= findLastInjection(history, entry.variant);
      }
      if (entry.cadence === 'turn') {
        if (entry.turnConsumed || entry.injectedAt !== null) continue;
        entry.turnConsumed = true;
      }
      const content = await entry.provider({
        lastInjectedAt: entry.injectedAt,
      });
      if (!this.entries.has(entry)) continue;
      if (content === undefined || content.trim().length === 0) continue;
      const message = this.reminders.appendSystemReminder(content, {
        kind: 'injection',
        variant: entry.variant,
      });
      this.selfInsertedMessages.set(message, entry);
      entry.injectedAt = this.context.get().length - 1;
      entry.resolveHistory = false;
      this.selfInsertedMessages.delete(message);
    }
  }

  private handleSplice(splice: ContextSplice): void {
    const selfInserted = new Map<ContextInjectionEntry, number>();
    splice.messages.forEach((message, offset) => {
      const entry = this.selfInsertedMessages.get(message);
      if (entry !== undefined) {
        selfInserted.set(entry, splice.start + offset);
      }
    });
    const previousLength =
      this.context.get().length - splice.messages.length + splice.deleteCount;

    for (const entry of this.entries) {
      const ownInsertedAt = selfInserted.get(entry);
      if (ownInsertedAt !== undefined) {
        entry.injectedAt = ownInsertedAt;
        entry.resolveHistory = false;
        continue;
      }
      entry.injectedAt = updateInjectedAt(entry.injectedAt, splice, previousLength);
    }
  }
}

type ContextSplice = {
  readonly start: number;
  readonly deleteCount: number;
  readonly messages: readonly ContextMessage[];
};

function updateInjectedAt(
  injectedAt: number | null,
  splice: ContextSplice,
  previousLength: number,
): number | null {
  if (injectedAt === null) return null;
  if (isClearSplice(splice, previousLength)) return null;
  if (isCompactionSplice(splice)) {
    const next = injectedAt - splice.deleteCount + 1;
    return next >= 0 ? next : null;
  }
  if (isSingleMessageRemoval(splice)) {
    if (injectedAt > splice.start) return injectedAt - 1;
    if (injectedAt === splice.start) return null;
    return injectedAt;
  }
  const deletedEnd = splice.start + splice.deleteCount;
  if (injectedAt < splice.start) return injectedAt;
  if (injectedAt < deletedEnd) return null;
  return injectedAt + splice.messages.length - splice.deleteCount;
}

function isClearSplice(splice: ContextSplice, previousLength: number): boolean {
  return splice.start === 0 && splice.deleteCount >= previousLength && splice.messages.length === 0;
}

function isCompactionSplice(splice: ContextSplice): boolean {
  return (
    splice.start === 0 &&
    splice.deleteCount > 0 &&
    splice.messages.length === 1 &&
    splice.messages[0]?.origin?.kind === 'compaction_summary'
  );
}

function isSingleMessageRemoval(splice: ContextSplice): boolean {
  return splice.deleteCount === 1 && splice.messages.length === 0;
}

function findLastInjection(
  history: readonly ContextMessage[],
  variant: string,
): number | null {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message?.origin?.kind === 'injection' && message.origin.variant === variant) {
      return index;
    }
  }
  return null;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextInjectorService,
  AgentContextInjectorService,
  InstantiationType.Delayed,
  'contextInjector',
);
