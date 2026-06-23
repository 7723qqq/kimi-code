import {
  Disposable,
  registerSingleton,
  SyncDescriptor,
  toDisposable,
} from '../../../di';

import { IContextMemory } from '../contextMemory/contextMemory';
import { ITurnRunner } from '../turnRunner/turnRunner';
import type { ContextMessage } from '../types';
import {
  IDynamicInjector,
  type DynamicInjectionProvider,
} from './dynamicInjector';

interface DynamicInjectionEntry {
  readonly provider: DynamicInjectionProvider;
  injectedAt: number | null;
}

export class DynamicInjectorService extends Disposable implements IDynamicInjector {
  private readonly entries = new Set<DynamicInjectionEntry>();

  constructor(
    @IContextMemory private readonly context: IContextMemory,
    @ITurnRunner turnRunner: ITurnRunner,
  ) {
    super();
    turnRunner.hooks.beforeStep.register('dynamic-injector', async (_ctx, next) => {
      await this.inject();
      await next();
    });
    context.hooks.onSpliced.register('dynamic-injector', (ctx, next) => {
      for (const entry of this.entries) {
        entry.injectedAt = updateInjectedAt(entry.injectedAt, ctx);
      }
      return next();
    });
  }

  register(provider: DynamicInjectionProvider) {
    const entry: DynamicInjectionEntry = {
      provider,
      injectedAt: null,
    };
    this.entries.add(entry);
    return toDisposable(() => {
      this.entries.delete(entry);
    });
  }

  private async inject(): Promise<void> {
    for (const entry of this.entries) {
      const content = await entry.provider({ injectedAt: entry.injectedAt });
      if (content === undefined || content.length === 0) continue;
      const injectedAt = this.context.getHistory().length;
      this.context.spliceHistory(
        injectedAt,
        0,
        createInjectionMessage(content),
      );
      entry.injectedAt = injectedAt;
    }
  }
}

function updateInjectedAt(
  injectedAt: number | null,
  splice: { start: number; deleteCount: number; messages: readonly ContextMessage[] },
): number | null {
  if (injectedAt === null) return null;
  const deletedEnd = splice.start + splice.deleteCount;
  if (injectedAt < splice.start) return injectedAt;
  if (injectedAt < deletedEnd) return null;
  return injectedAt + splice.messages.length - splice.deleteCount;
}

function createInjectionMessage(content: string): ContextMessage {
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `<system-reminder>\n${content.trim()}\n</system-reminder>`,
      },
    ],
    toolCalls: [],
    origin: { kind: 'injection', variant: 'dynamic' },
  };
}

registerSingleton(IDynamicInjector, new SyncDescriptor(DynamicInjectorService, [], true));
