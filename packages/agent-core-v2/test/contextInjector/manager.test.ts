import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import {
  createServices,
  type TestInstantiationService,
} from '#/_base/di/test';
import { IAgentContextInjectorService } from '#/contextInjector';
import { AgentContextInjectorService } from '#/contextInjector/contextInjectorService';
import { IAgentContextMemoryService, type ContextMessage } from '#/contextMemory';
import { IAgentProfileService } from '#/profile';
import { IAgentSystemReminderService } from '#/systemReminder';
import { AgentSystemReminderService } from '#/systemReminder/systemReminderService';
import { IAgentTodoListService, TODO_LIST_REMINDER_VARIANT } from '#/todoList';
import { AgentTodoListService } from '#/todoList/todoListService';
import { IAgentToolRegistryService } from '#/toolRegistry';
import { IAgentToolStoreService } from '#/toolStore';
import { IAgentTurnService } from '#/turn';
import { registerContextMemoryServices } from '../contextMemory/stubs';
import { stubTurnWithHooks } from '../turn/stubs';

type InjectableContextInjector = IAgentContextInjectorService & {
  inject(): Promise<void>;
};

type ContextInjectorInternals = {
  entries: Set<{ variant: string }>;
};

function injector(ix: TestInstantiationService): InjectableContextInjector {
  return ix.get(IAgentContextInjectorService) as InjectableContextInjector;
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

function lastText(context: IAgentContextMemoryService): string | undefined {
  const message = context.get().at(-1);
  const part = message?.content[0];
  return part?.type === 'text' ? part.text : undefined;
}

describe('AgentContextInjectorService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let context: IAgentContextMemoryService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [registerContextMemoryServices],
      strict: true,
      additionalServices: (reg) => {
        reg.defineInstance(IAgentTurnService, stubTurnWithHooks());
        reg.define(IAgentSystemReminderService, AgentSystemReminderService);
        reg.define(IAgentContextInjectorService, AgentContextInjectorService);
      },
    });
    context = ix.get(IAgentContextMemoryService);
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

  it('resets every stored injection index after context clear', async () => {
    const seenA: Array<number | null> = [];
    const seenB: Array<number | null> = [];

    injector(ix).register('recording_a', ({ lastInjectedAt }) => {
      seenA.push(lastInjectedAt);
      return lastInjectedAt === null ? 'recorded reminder A' : undefined;
    });
    injector(ix).register('recording_b', ({ lastInjectedAt }) => {
      seenB.push(lastInjectedAt);
      return lastInjectedAt === null ? 'recorded reminder B' : undefined;
    });

    await injector(ix).inject();
    context.splice(0, context.get().length, []);
    await injector(ix).inject();

    expect(seenA).toEqual([null, null]);
    expect(seenB).toEqual([null, null]);
    expect(context.get().map((message) => message.origin)).toEqual([
      { kind: 'injection', variant: 'recording_a' },
      { kind: 'injection', variant: 'recording_b' },
    ]);
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

  it('keeps every injection index aligned after compaction preserves injected messages', async () => {
    const seenA: Array<number | null> = [];
    const seenB: Array<number | null> = [];

    context.splice(0, 0, [
      userMessage('old request'),
      userMessage('old follow-up'),
    ]);
    injector(ix).register('recording_a', ({ lastInjectedAt }) => {
      seenA.push(lastInjectedAt);
      return lastInjectedAt === null ? 'recorded reminder A' : undefined;
    });
    injector(ix).register('recording_b', ({ lastInjectedAt }) => {
      seenB.push(lastInjectedAt);
      return lastInjectedAt === null ? 'recorded reminder B' : undefined;
    });

    await injector(ix).inject();
    context.splice(0, 2, [compactionSummary('Compacted summary.')]);
    await injector(ix).inject();

    expect(seenA).toEqual([null, 1]);
    expect(seenB).toEqual([null, 2]);
    expect(context.get().map((message) => message.origin)).toEqual([
      { kind: 'compaction_summary' },
      { kind: 'injection', variant: 'recording_a' },
      { kind: 'injection', variant: 'recording_b' },
    ]);
  });
});

describe('AgentContextInjectorService registration', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [registerContextMemoryServices],
      strict: true,
      additionalServices: (reg) => {
        reg.defineInstance(IAgentTurnService, stubTurnWithHooks());
        reg.define(IAgentSystemReminderService, AgentSystemReminderService);
        reg.define(IAgentContextInjectorService, AgentContextInjectorService);
        reg.definePartialInstance(IAgentProfileService, {
          isToolActive: () => false,
        });
        reg.definePartialInstance(IAgentToolStoreService, {
          data: () => ({}),
        });
        reg.definePartialInstance(IAgentToolRegistryService, {
          register: () => toDisposable(() => {}),
        });
        reg.define(IAgentTodoListService, AgentTodoListService);
      },
    });
  });

  afterEach(() => disposables.dispose());

  it('registers the todo-list reminder when the todo-list service is resolved', () => {
    ix.get(IAgentTodoListService);

    const entries = [
      ...(injector(ix) as unknown as ContextInjectorInternals).entries,
    ];

    expect(entries.some((entry) => entry.variant === TODO_LIST_REMINDER_VARIANT)).toBe(true);
  });
});
