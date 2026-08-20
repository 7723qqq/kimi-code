import { describe, expect, it } from 'vitest';

import type { ContextMessage } from '#/agent/contextMemory/types';
import { type TodoItem } from '#/session/todo/todoItem';
import { todoActiveReminder, todoListStaleReminder } from '#/session/todo/todoListReminder';

function assistantMessage(): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'working' }],
    toolCalls: [],
  };
}

function todoListWrite(todos: readonly TodoItem[]): ContextMessage {
  return {
    role: 'assistant',
    content: [],
    toolCalls: [
      {
        type: 'function',
        id: 'call_todo_write',
        name: 'TodoList',
        arguments: JSON.stringify({ todos }),
      },
    ],
  };
}

function todoListQuery(): ContextMessage {
  return {
    role: 'assistant',
    content: [],
    toolCalls: [
      {
        type: 'function',
        id: 'call_todo_query',
        name: 'TodoList',
        arguments: JSON.stringify({}),
      },
    ],
  };
}

function todoListUpdatesWrite(updates: unknown): ContextMessage {
  return {
    role: 'assistant',
    content: [],
    toolCalls: [
      {
        type: 'function',
        id: 'call_todo_updates',
        name: 'TodoList',
        arguments: JSON.stringify({ updates }),
      },
    ],
  };
}

function priorTodoReminder(): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: '<system-reminder>\nPrior todo reminder\n</system-reminder>' }],
    toolCalls: [],
    origin: { kind: 'injection', variant: 'todo_list_reminder' },
  };
}

describe('todoListStaleReminder', () => {
  it('skips reminder injection when TodoList is not active', async () => {
    const history = Array.from({ length: 10 }, () => assistantMessage());
    const result = todoListStaleReminder({
      history,
      todos: [
        {
          id: 'T1',
          parentId: null,
          kind: 'task',
          title: 'Investigate todo reminder',
          status: 'in_progress',
        },
      ],
      active: false,
    });

    expect(result).toBeUndefined();
  });

  it('injects a reminder after enough assistant turns since the last TodoList write', async () => {
    const todos: TodoItem[] = [
      {
        id: 'T1',
        parentId: null,
        kind: 'task',
        title: 'Read current TodoList implementation',
        status: 'in_progress',
      },
      {
        id: 'T2',
        parentId: null,
        kind: 'task',
        title: 'Add reminder injector tests',
        status: 'pending',
      },
    ];
    const history = [todoListWrite(todos), ...Array.from({ length: 10 }, () => assistantMessage())];
    const result = todoListStaleReminder({ history, todos, active: true });

    expect(result).toContain('Current todo list:');
    expect(result).toContain('[in_progress] T1: Read current TodoList implementation');
    expect(result).toContain('[pending] T2: Add reminder injector tests');
  });

  it('does not inject before the assistant-turn threshold', async () => {
    const todos: TodoItem[] = [
      { id: 'T1', parentId: null, kind: 'task', title: 'Read code', status: 'in_progress' },
    ];
    const history = [todoListWrite(todos), ...Array.from({ length: 9 }, () => assistantMessage())];
    const result = todoListStaleReminder({ history, todos, active: true });

    expect(result).toBeUndefined();
  });

  it('does not inject another reminder before the reminder spacing threshold', async () => {
    const todos: TodoItem[] = [
      { id: 'T1', parentId: null, kind: 'task', title: 'Read code', status: 'in_progress' },
    ];
    const history = [
      todoListWrite(todos),
      ...Array.from({ length: 10 }, () => assistantMessage()),
      priorTodoReminder(),
      ...Array.from({ length: 9 }, () => assistantMessage()),
    ];
    const result = todoListStaleReminder({ history, todos, active: true });

    expect(result).toBeUndefined();
  });

  it('does not treat TodoList query mode as a write', async () => {
    const todos: TodoItem[] = [
      { id: 'T1', parentId: null, kind: 'task', title: 'Read code', status: 'in_progress' },
    ];
    const history = [
      todoListWrite(todos),
      ...Array.from({ length: 5 }, () => assistantMessage()),
      todoListQuery(),
      ...Array.from({ length: 4 }, () => assistantMessage()),
    ];
    const result = todoListStaleReminder({ history, todos, active: true });

    expect(result).toBeDefined();
  });
});

describe('todoListStaleReminder with updates mode', () => {
  it('treats the updates mode as a write', async () => {
    const history: ContextMessage[] = [
      assistantMessage(),
      assistantMessage(),
      todoListUpdatesWrite([{ id: 'T1', status: 'done' }]),
      ...Array.from({ length: 12 }, assistantMessage),
    ];
    const todos: TodoItem[] = [
      { id: 'T1', parentId: null, kind: 'task', title: 'a', status: 'done' },
    ];
    const result = todoListStaleReminder({ active: true, history, todos });
    expect(result).toBeDefined();
  });
});

describe('todoActiveReminder', () => {
  const inProgress = (id: string, title: string, progress?: number): TodoItem => ({
    id,
    parentId: null,
    kind: 'task',
    title,
    status: 'in_progress',
    ...(progress !== undefined ? { progress } : {}),
  });
  const pending = (id: string, title: string): TodoItem => ({
    id,
    parentId: null,
    kind: 'task',
    title,
    status: 'pending',
  });
  const done = (id: string): TodoItem => ({
    id,
    parentId: null,
    kind: 'task',
    title: 'd',
    status: 'done',
  });

  it('returns undefined for an empty list', () => {
    expect(todoActiveReminder([])).toBeUndefined();
  });

  it('returns undefined when nothing is in progress', () => {
    expect(todoActiveReminder([done('T1'), pending('T2', 'next')])).toBeUndefined();
  });

  it('summarizes in-progress items and the next pending', () => {
    const result = todoActiveReminder([
      inProgress('T3', 'Fix auth', 40),
      pending('T4', 'Add tests'),
      done('T1'),
    ]);
    expect(result).toContain('[in_progress] T3: Fix auth (40%)');
    expect(result).toContain('next: T4: Add tests');
    expect(result).toContain('1/3 done');
  });

  it('lists multiple in-progress items without a next when none is pending', () => {
    const result = todoActiveReminder([inProgress('T1', 'a'), inProgress('T2', 'b'), done('T3')]);
    expect(result).toContain('[in_progress] T1: a');
    expect(result).toContain('[in_progress] T2: b');
    expect(result).not.toContain('next:');
  });
});
