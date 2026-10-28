import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { waitUntil } from '#test/helpers/waitFor';

import { KeyedResourceLeasePool } from '#/_base/lifecycle/keyedResource';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IEventBus } from '#/app/event/eventBus';
import { IFeatureManager } from '#/app/feature/featureManager';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { TodoFeature } from '#/features/todo/todoFeature';
import { IAgentTodoService } from '#/features/todo/todoService';
import type { TodoItem } from '#/features/todo/todoItem';
import { TODO_LIST_REMINDER_VARIANT } from '#/features/todo/todoListReminder';
import { TodoUpdated } from '#/features/todo/todoOps';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import type { WireRecord } from '#/wire/record';

import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import {
  createTestAgent,
  InMemoryWireRecordPersistence,
  type TestAgentContext,
} from '../../harness';

function todoItem(id: string, title: string, status: TodoItem['status']): TodoItem {
  return { id, parentId: null, kind: 'task', title, status };
}

function reminderCount(memory: IAgentContextMemoryService): number {
  return memory.get().filter(
    (message) =>
      message.origin?.kind === 'injection' && message.origin.variant === TODO_LIST_REMINDER_VARIANT,
  ).length;
}

function appendAssistantTurns(memory: IAgentContextMemoryService, count: number): void {
  for (let i = 0; i < count; i += 1) {
    memory.append({
      role: 'assistant',
      content: [{ type: 'text', text: `turn ${i}` }],
      toolCalls: [],
    });
  }
}

describe('AgentTodoService', () => {
  let ctx: TestAgentContext;

  beforeEach(async () => {
    ctx = createTestAgent();
    await ctx.restorePersisted();
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  it('replaces, reads, and clears todos through the domain API', async () => {
    const todo = ctx.get(IAgentTodoService);

    expect(todo.get()).toEqual([]);

    await todo.replace([
      todoItem('T1', 'first', 'pending'),
      todoItem('T2', 'second', 'in_progress'),
    ]);
    expect(todo.get()).toEqual([
      todoItem('T1', 'first', 'pending'),
      todoItem('T2', 'second', 'in_progress'),
    ]);

    await todo.clear();
    expect(todo.get()).toEqual([]);
  });

  it('emits each actual change once', async () => {
    const todo = ctx.get(IAgentTodoService);
    const seen: TodoItem[][] = [];
    const subscription = todo.onDidChange((todos) => { seen.push([...todos]); });

    await todo.replace([todoItem('T1', 'a', 'pending')]);
    await todo.replace([
      todoItem('T1', 'a', 'pending'),
      todoItem('T2', 'b', 'done'),
    ]);
    await todo.clear();

    expect(seen).toEqual([
      [todoItem('T1', 'a', 'pending')],
      [
        todoItem('T1', 'a', 'pending'),
        todoItem('T2', 'b', 'done'),
      ],
      [],
    ]);
    subscription.dispose();
  });

  it('appends todos through the existing tools.update_store wire record', async () => {
    const todo = ctx.get(IAgentTodoService);
    await todo.replace([todoItem('T1', 'persist me', 'in_progress')]);

    const records = await ctx.persistedWireRecords();
    expect(records.filter((record) => record.type === 'tools.update_store')).toEqual([{
      type: 'tools.update_store',
      agentId: 'main',
      key: 'todo',
      value: [todoItem('T1', 'persist me', 'in_progress')],
      time: expect.any(Number),
    }]);
  });

  it('publishes a todo.updated event with the full item shape after the wire record', async () => {
    const todo = ctx.get(IAgentTodoService);
    const seen: TodoUpdated[] = [];
    const subscription = ctx.get(IEventBus).subscribe(TodoUpdated, (event) => {
      seen.push(event as unknown as TodoUpdated);
    });

    const items: TodoItem[] = [
      { id: 'M1', parentId: null, kind: 'milestone', title: 'phase', status: 'pending' },
      {
        id: 'M1.1',
        parentId: 'M1',
        kind: 'task',
        title: 'leaf',
        status: 'in_progress',
        progress: 55,
        description: 'still going',
      },
    ];
    await todo.replace(items);
    subscription.dispose();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ agentId: 'main', rev: 1 });
    expect(seen[0]?.todos).toEqual(items);
  });

  it('publishes an empty list when cleared', async () => {
    const todo = ctx.get(IAgentTodoService);
    await todo.replace([todoItem('T1', 'x', 'pending')]);
    const seen: TodoUpdated[] = [];
    const subscription = ctx.get(IEventBus).subscribe(TodoUpdated, (event) => {
      seen.push(event as unknown as TodoUpdated);
    });

    await todo.clear();
    subscription.dispose();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.todos).toEqual([]);
    expect(seen[0]?.rev).toBe(2);
  });

  it('never persists todo.updated to the wire', async () => {
    const todo = ctx.get(IAgentTodoService);
    await todo.replace([todoItem('T1', 'a', 'pending')]);
    await todo.replace([todoItem('T1', 'a', 'done')]);
    await todo.clear();

    const records = await ctx.persistedWireRecords();
    expect(records.filter((record) => record.type === 'todo.updated')).toEqual([]);
    expect(records.filter((record) => record.type === 'tools.update_store')).toHaveLength(3);
  });

  it('isolates todos between agents', async () => {
    const lifecycle = ctx.get(IAgentLifecycleService);
    const sub = await lifecycle.create({ agentId: 'agent-1' });
    const mainTodo = ctx.get(IAgentTodoService);
    const subTodo = lifecycle.handleOf(sub.agentId)!.accessor.get(IAgentTodoService);

    await mainTodo.replace([todoItem('T1', 'main todo', 'pending')]);
    await subTodo.replace([todoItem('T1', 'sub todo', 'done')]);

    expect(mainTodo.get()).toEqual([todoItem('T1', 'main todo', 'pending')]);
    expect(subTodo.get()).toEqual([todoItem('T1', 'sub todo', 'done')]);
    await lifecycle.remove(sub);
  });

  it('stamps todo.updated with the writing agent id', async () => {
    const lifecycle = ctx.get(IAgentLifecycleService);
    const sub = await lifecycle.create({ agentId: 'agent-1' });
    const mainSeen: TodoUpdated[] = [];
    const mainSubscription = ctx.get(IEventBus).subscribe(TodoUpdated, (event) => {
      mainSeen.push(event as unknown as TodoUpdated);
    });
    const subScope = lifecycle.handleOf(sub.agentId)!;
    const subSeen: TodoUpdated[] = [];
    const subSubscription = subScope.accessor.get(IEventBus).subscribe(TodoUpdated, (event) => {
      subSeen.push(event as unknown as TodoUpdated);
    });

    await ctx.get(IAgentTodoService).replace([todoItem('T1', 'main', 'pending')]);
    await subScope.accessor.get(IAgentTodoService).replace([todoItem('T1', 'sub', 'pending')]);
    mainSubscription.dispose();
    subSubscription.dispose();

    expect(mainSeen.map((event) => event.agentId)).toEqual(['main']);
    expect(subSeen.map((event) => event.agentId)).toEqual(['agent-1']);
    await lifecycle.remove(sub);
  });

  it('restores todos from persisted wire records after restart', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const first = createTestAgent({ persistence, autoConfigure: false });
    await first.restorePersisted();
    await first.get(IAgentTodoService).replace([todoItem('T1', 'kept', 'in_progress')]);
    await first.dispose();

    const restarted = createTestAgent({ persistence, autoConfigure: false });
    try {
      await restarted.restorePersisted();
      expect(restarted.get(IAgentTodoService).get()).toEqual([
        todoItem('T1', 'kept', 'in_progress'),
      ]);
    } finally {
      await restarted.dispose();
    }
  });

  it('publishes the restored list on wire replay, not only on a live write', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const first = createTestAgent({ persistence, autoConfigure: false });
    await first.restorePersisted();
    await first.get(IAgentTodoService).replace([todoItem('T1', 'kept', 'in_progress')]);
    await first.dispose();

    const restarted = createTestAgent({ persistence, autoConfigure: false });
    const seen: TodoUpdated[] = [];
    try {
      const subscription = restarted.get(IEventBus).subscribe(TodoUpdated, (event) => {
        seen.push(event as unknown as TodoUpdated);
      });
      await restarted.restorePersisted();
      subscription.dispose();

      expect(seen.at(-1)?.todos).toEqual([todoItem('T1', 'kept', 'in_progress')]);
    } finally {
      await restarted.dispose();
    }
  });

  it('restores todos and resumes operations when the feature is re-provided after restore', async () => {
    await ctx.get(IAgentTodoService).replace([todoItem('T1', 'kept', 'in_progress')]);

    await ctx.get(IFeatureManager).unprovideUnit('todo');
    expect(() => ctx.get(IAgentTodoService)).toThrow("unknown service 'agentTodoService'");

    ctx.get(IFeatureManager).provideUnit(TodoFeature);

    const revived = await waitUntil(() => {
      const service = ctx.get(IAgentTodoService);
      expect(service.get()).toEqual([todoItem('T1', 'kept', 'in_progress')]);
      return service;
    });
    await revived.replace([
      todoItem('T1', 'kept', 'done'),
      todoItem('T2', 'added', 'pending'),
    ]);
    expect(revived.get()).toEqual([
      todoItem('T1', 'kept', 'done'),
      todoItem('T2', 'added', 'pending'),
    ]);
  });

  it('filters malformed persisted values during replay', async () => {
    const persistence = new InMemoryWireRecordPersistence();
    const seeded = createTestAgent({ persistence, autoConfigure: false });
    try {
      persistence.records.push({
        type: 'tools.update_store',
        key: 'todo',
        value: [
          { title: 'valid', status: 'done' },
          { title: 'missing status' },
          { title: 123, status: 'pending' },
          'garbage',
        ],
      } as unknown as WireRecord);
      await seeded.restorePersisted();

      expect(seeded.get(IAgentTodoService).get()).toEqual([todoItem('T1', 'valid', 'done')]);
    } finally {
      await seeded.dispose();
    }
  });

  it('reminds the main agent only while its list has open items', async () => {
    const lifecycle = ctx.get(IAgentLifecycleService);
    const todo = ctx.get(IAgentTodoService);
    const reminder = ctx.get(IAgentReminderService);

    appendAssistantTurns(ctx.context, 5);
    await reminder.reconcileWhenIdle(TODO_LIST_REMINDER_VARIANT);
    expect(reminderCount(ctx.context)).toBe(0);

    await todo.replace([todoItem('T1', 'track me', 'pending')]);
    appendAssistantTurns(ctx.context, 5);
    await reminder.reconcileWhenIdle(TODO_LIST_REMINDER_VARIANT);
    expect(reminderCount(ctx.context)).toBe(1);

    await todo.replace([todoItem('T1', 'track me', 'done')]);
    appendAssistantTurns(ctx.context, 5);
    await reminder.reconcileWhenIdle(TODO_LIST_REMINDER_VARIANT);
    expect(reminderCount(ctx.context)).toBe(1);

    const sub = await lifecycle.create({ agentId: 'agent-1' });
    const subTodo = lifecycle.handleOf(sub.agentId)!.accessor.get(IAgentTodoService);
    const subReminder = lifecycle.handleOf(sub.agentId)!.accessor.get(IAgentReminderService);
    const subMemory = lifecycle.handleOf(sub.agentId)!.accessor.get(IAgentContextMemoryService);
    await subTodo.replace([todoItem('T1', 'sub task', 'pending')]);
    appendAssistantTurns(subMemory, 5);
    await subReminder.reconcileWhenIdle(TODO_LIST_REMINDER_VARIANT);
    expect(reminderCount(subMemory)).toBe(0);
    await lifecycle.remove(sub);
  });

  it('tracks stale reminders and how each main-agent turn leaves the list', async () => {
    const records: TelemetryRecord[] = [];
    const tracked = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      await tracked.restorePersisted();
      const todo = tracked.get(IAgentTodoService);
      const bus = tracked.get(IEventBus);

      bus.publish(new TurnStarted({ agentId: 'main', turnId: 1, origin: { kind: 'user' } }));
      await todo.replace([
        todoItem('T1', 'parse config', 'done'),
        todoItem('T2', 'update callers', 'in_progress'),
      ]);
      appendAssistantTurns(tracked.context, 5);
      await tracked.get(IAgentReminderService).reconcileWhenIdle(TODO_LIST_REMINDER_VARIANT);
      bus.publish(new TurnEnded({ agentId: 'main', turnId: 1, reason: 'completed' }));
      bus.publish(new TurnStarted({ agentId: 'main', turnId: 2, origin: { kind: 'user' } }));
      bus.publish(new TurnEnded({ agentId: 'main', turnId: 2, reason: 'cancelled' }));
      bus.publish(new TurnStarted({ agentId: 'main', turnId: 3, origin: { kind: 'user' } }));
      await todo.replace([]);
      bus.publish(new TurnEnded({ agentId: 'main', turnId: 3, reason: 'completed' }));
      bus.publish(new TurnStarted({ agentId: 'main', turnId: 4, origin: { kind: 'user' } }));
      bus.publish(new TurnEnded({ agentId: 'main', turnId: 4, reason: 'completed' }));

      const propertiesOf = (event: string) =>
        records.filter((record) => record.event === event).map((record) => record.properties);
      expect(propertiesOf('todo_reminder_shown')).toEqual([
        expect.objectContaining({ steps_since_write: 5, item_count: 2, open_count: 1 }),
      ]);
      expect(propertiesOf('todo_turn_ended')).toEqual([
        expect.objectContaining({
          turn_id: 1,
          reason: 'completed',
          item_count: 2,
          open_count: 1,
          updated_in_turn: true,
        }),
        expect.objectContaining({
          turn_id: 2,
          reason: 'cancelled',
          item_count: 2,
          open_count: 1,
          updated_in_turn: false,
        }),
        expect.objectContaining({
          turn_id: 3,
          reason: 'completed',
          item_count: 0,
          open_count: 0,
          updated_in_turn: true,
        }),
      ]);
    } finally {
      await tracked.dispose();
    }
  });
});

describe('KeyedResourceLeasePool', () => {
  function nextTick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('deduplicates concurrent materialization by key', async () => {
    let creates = 0;
    const pool = new KeyedResourceLeasePool(
      { owner: 'todo.test', generation: 1 },
      async () => {
        creates += 1;
        await nextTick();
        return { dispose: () => {} };
      },
    );

    const [first, second] = await Promise.all([pool.acquire('main'), pool.acquire('main')]);
    expect(creates).toBe(1);
    expect(first.resource).toBe(second.resource);
    first.release();
    second.release();
    await pool.withdraw();
  });

  it('rejects stale generation acquires while an existing lease drains', async () => {
    let disposed = false;
    const pool = new KeyedResourceLeasePool(
      { owner: 'todo.test', generation: 2 },
      () => ({
        dispose: async () => {
          await nextTick();
          disposed = true;
        },
      }),
    );
    const lease = await pool.acquire('main');
    const withdrawal = pool.withdraw();

    await expect(pool.acquire('main')).rejects.toThrow('todo.test:2 is withdrawn');
    await nextTick();
    expect(disposed).toBe(false);
    lease.release();
    await withdrawal;
    expect(disposed).toBe(true);
  });
});
