import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import {
  createServices,
  type TestInstantiationService,
} from '#/_base/di/test';
import { IContextInjector } from '#/contextInjector';
import { ContextInjectorService } from '#/contextInjector/contextInjectorService';
import { IContextMemory, type ContextMessage } from '#/contextMemory';
import { IProfileService } from '#/profile';
import { ISystemReminderService } from '#/systemReminder';
import { SystemReminderService } from '#/systemReminder/systemReminderService';
import { ITodoListService, TODO_LIST_REMINDER_VARIANT } from '#/todoList';
import { TodoListService } from '#/todoList/todoListService';
import { IToolRegistry } from '#/toolRegistry';
import { IToolStoreService } from '#/toolStore';
import { ITurnService } from '#/turn';
import { registerContextMemoryServices } from '../contextMemory/stubs';
import { stubTurnWithHooks } from '../turn/stubs';

type InjectableContextInjector = IContextInjector & {
  inject(): Promise<void>;
};

type ContextInjectorInternals = {
  entries: Set<{ variant: string }>;
};

function injector(ix: TestInstantiationService): InjectableContextInjector {
  return ix.get(IContextInjector) as InjectableContextInjector;
}

function userMessage(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: { kind: 'user' },
  };
}

function compactionSummary(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: { kind: 'compaction_summary' },
  };
}

function lastText(context: IContextMemory): string | undefined {
  const message = context.get().at(-1);
  const part = message?.content[0];
  return part?.type === 'text' ? part.text : undefined;
}

describe('ContextInjectorService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let context: IContextMemory;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [registerContextMemoryServices],
      strict: true,
      additionalServices: (reg) => {
        reg.defineInstance(ITurnService, stubTurnWithHooks());
        reg.define(ISystemReminderService, SystemReminderService);
        reg.define(IContextInjector, ContextInjectorService);
      },
    });
    context = ix.get(IContextMemory);
  });

  afterEach(() => disposables.dispose());

  it('registers providers and appends injection messages with the provider variant', async () => {
    const seen: Array<number | null> = [];

    injector(ix).register('recording_test', ({ lastInjectedAt }) => {
      seen.push(lastInjectedAt);
      return 'recorded reminder';
    });

    await injector(ix).inject();

    expect(seen).toEqual([null]);
    expect(lastText(context)).toContain('<system-reminder>');
    expect(lastText(context)).toContain('recorded reminder');
    expect(context.get().at(-1)?.origin).toEqual({
      kind: 'injection',
      variant: 'recording_test',
    });
  });

  it('passes the previous injection index back to the provider', async () => {
    const seen: Array<number | null> = [];

    injector(ix).register('recording_test', ({ lastInjectedAt }) => {
      seen.push(lastInjectedAt);
      return lastInjectedAt === null ? 'recorded reminder' : undefined;
    });

    await injector(ix).inject();
    await injector(ix).inject();

    expect(seen).toEqual([null, 0]);
    expect(context.get()).toHaveLength(1);
  });

  it('resets the stored injection index after context clear', async () => {
    const seen: Array<number | null> = [];

    injector(ix).register('recording_test', ({ lastInjectedAt }) => {
      seen.push(lastInjectedAt);
      return lastInjectedAt === null ? 'recorded reminder' : undefined;
    });

    await injector(ix).inject();
    context.splice(0, context.get().length, []);
    await injector(ix).inject();

    expect(seen).toEqual([null, null]);
    expect(context.get()).toHaveLength(1);
    expect(context.get()[0]?.origin).toEqual({
      kind: 'injection',
      variant: 'recording_test',
    });
  });

  it('keeps the injection index aligned after compaction replaces the prefix', async () => {
    const seen: Array<number | null> = [];

    context.splice(0, 0, [userMessage('before reminder')]);
    injector(ix).register('recording_test', ({ lastInjectedAt }) => {
      seen.push(lastInjectedAt);
      return lastInjectedAt === null ? 'recorded reminder' : undefined;
    });

    await injector(ix).inject();
    context.splice(
      0,
      2,
      [compactionSummary('Compacted summary.')],
    );
    await injector(ix).inject();

    expect(seen).toEqual([null, 0]);
    expect(context.get()).toHaveLength(1);
    expect(context.get()[0]?.origin).toEqual({ kind: 'compaction_summary' });
  });
});

describe('ContextInjectorService registration', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [registerContextMemoryServices],
      strict: true,
      additionalServices: (reg) => {
        reg.defineInstance(ITurnService, stubTurnWithHooks());
        reg.define(ISystemReminderService, SystemReminderService);
        reg.define(IContextInjector, ContextInjectorService);
        reg.definePartialInstance(IProfileService, {
          isToolActive: () => false,
        });
        reg.definePartialInstance(IToolStoreService, {
          data: () => ({}),
        });
        reg.definePartialInstance(IToolRegistry, {
          register: () => toDisposable(() => {}),
        });
        reg.define(ITodoListService, TodoListService);
      },
    });
  });

  afterEach(() => disposables.dispose());

  it('registers the todo-list reminder when the todo-list service is resolved', () => {
    ix.get(ITodoListService);

    const entries = [
      ...(injector(ix) as unknown as ContextInjectorInternals).entries,
    ];

    expect(entries.some((entry) => entry.variant === TODO_LIST_REMINDER_VARIANT)).toBe(true);
  });
});
