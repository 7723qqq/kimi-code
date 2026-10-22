import { describe, expect, it } from 'bun:test';

import { todoItemSchema } from '#/features/todo/todoItem';
import { TodoUpdated } from '#/features/todo/todoOps';

const item = {
  id: 'T1',
  parentId: null,
  kind: 'task' as const,
  title: 'ship',
  status: 'in_progress' as const,
  progress: 40,
};

describe('TodoUpdated event declaration', () => {
  it('is observable so the agent event bus forwards it', () => {
    expect(TodoUpdated.observable).toBe(true);
  });

  it('is not durable so it never produces a second wire record', () => {
    expect(TodoUpdated.durable).toBe(false);
  });

  it('carries the full todo item shape plus a revision', () => {
    expect(TodoUpdated.type).toBe('todo.updated');
    const parsed = TodoUpdated.schema?.parse({ agentId: 'main', todos: [item], rev: 3 });
    expect(parsed).toEqual({ agentId: 'main', todos: [item], rev: 3 });
  });

  it('rejects a payload without rev', () => {
    expect(() => TodoUpdated.schema?.parse({ agentId: 'main', todos: [] })).toThrow();
  });

  it('rejects a negative or fractional rev', () => {
    expect(() =>
      TodoUpdated.schema?.parse({ agentId: 'main', todos: [], rev: -1 }),
    ).toThrow();
    expect(() =>
      TodoUpdated.schema?.parse({ agentId: 'main', todos: [], rev: 1.5 }),
    ).toThrow();
  });

  it('rejects items missing the fields the UI renders', () => {
    expect(() => TodoUpdated.schema?.parse({ agentId: 'main', todos: [{ title: 'x' }], rev: 1 })).toThrow();
  });

  it('exposes the shared item schema to the event payload', () => {
    expect(todoItemSchema.safeParse(item).success).toBe(true);
    expect(todoItemSchema.safeParse({ ...item, status: 'bogus' }).success).toBe(false);
    expect(todoItemSchema.safeParse({ ...item, kind: 'bogus' }).success).toBe(false);
  });
});
