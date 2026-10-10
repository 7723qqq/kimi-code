import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IAgentTodoService } from '#/features/todo/todoService';
import { TODO_LIST_TOOL_NAME, type TodoItem } from '#/features/todo/todoItem';
import {
  ITodoListTool,
  TodoListInputSchema,
  type TodoListInput,
} from '#/features/todo/tools/todo-list/todo-list';
import { compileToolArgsValidator, validateToolArgs } from '#/tool/args-validator';
import { executeTool } from '../../../tools/fixtures/execute-tool';

import { createTestAgent, type TestAgentContext } from '../../../harness';

const signal = new AbortController().signal;

function todoItem(id: string, title: string, status: TodoItem['status']): TodoItem {
  return { id, parentId: null, kind: 'task', title, status };
}

describe('TodoListTool', () => {
  let ctx: TestAgentContext;

  beforeEach(async () => {
    ctx = createTestAgent();
    await ctx.restorePersisted();
  });

  afterEach(async () => {
    await ctx.dispose();
  });

  async function seed(todos: readonly TodoItem[]): Promise<void> {
    await ctx.get(IAgentTodoService).replace(todos);
  }

  function todos(): readonly TodoItem[] {
    return ctx.get(IAgentTodoService).get();
  }

  it('has name, description, and parameters from the current schema', () => {
    const tool = ctx.get(ITodoListTool);

    expect(TODO_LIST_TOOL_NAME).toBe('TodoList');
    expect(tool.name).toBe(TODO_LIST_TOOL_NAME);
    expect(tool.description.length).toBeGreaterThan(0);
    expect(TodoListInputSchema.safeParse({}).success).toBe(true);
    expect(
      TodoListInputSchema.safeParse({ todos: [{ title: 'x', status: 'wip' }] }).success,
    ).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        todos: { type: 'array' },
      },
    });
  });

  it('accepts the item fields the tool description tells the model to send', async () => {
    const tool = ctx.get(ITodoListTool);
    const args: TodoListInput = {
      todos: [
        { id: 'M1', parentId: null, kind: 'milestone', title: 'Phase 1', status: 'in_progress' },
        {
          id: 'M1.1',
          parentId: 'M1',
          kind: 'task',
          title: 'read file',
          status: 'in_progress',
          progress: 50,
          description: 'a longer note',
        },
      ],
    };

    const validator = compileToolArgsValidator(tool.parameters);
    expect(validateToolArgs(validator, args as never)).toBeNull();

    const result = await executeTool(tool, {
      turnId: 1,
      toolCallId: 'call_1',
      args,
      signal,
    });

    expect(result).toMatchObject({ isError: false });
    expect(todos()).toEqual([
      { id: 'M1', parentId: null, kind: 'milestone', title: 'Phase 1', status: 'in_progress' },
      {
        id: 'M1.1',
        parentId: 'M1',
        kind: 'task',
        title: 'read file',
        status: 'in_progress',
        progress: 50,
        description: 'a longer note',
      },
    ]);
  });

  it('renders the milestone hierarchy and progress a documented write produces', async () => {
    const tool = ctx.get(ITodoListTool);

    const result = await executeTool(tool, {
      turnId: 1,
      toolCallId: 'call_1',
      args: {
        todos: [
          { id: 'M1', parentId: null, kind: 'milestone', title: 'Phase 1', status: 'in_progress' },
          {
            id: 'M1.1',
            parentId: 'M1',
            kind: 'task',
            title: 'read file',
            status: 'in_progress',
            progress: 50,
          },
        ],
      },
      signal,
    });

    expect(result).toMatchObject({ isError: false });
    expect(result.output).toContain('M1: Phase 1 (0/1 · 50%)');
    expect(result.output).toContain('M1.1: read file (50%)');
  });

  it('rejects item fields outside the documented contract', () => {
    const tool = ctx.get(ITodoListTool);
    const validator = compileToolArgsValidator(tool.parameters);

    expect(
      validateToolArgs(validator, { todos: [{ title: 'x', status: 'pending', bogus: 1 }] } as never),
    ).toContain('bogus');
    expect(
      validateToolArgs(validator, { todos: [{ title: 'x', status: 'pending', progress: 150 }] } as never),
    ).not.toBeNull();
  });

  it('query mode renders the current list without mutating it', async () => {
    await seed([todoItem('T1', 'existing', 'in_progress')]);
    const tool = ctx.get(ITodoListTool);

    const result = await executeTool(tool, {
      turnId: 1,
      toolCallId: 'call_1',
      args: {},
      signal,
    });

    expect(result).toMatchObject({ isError: false });
    expect(result.output).toContain('Current todo list');
    expect(result.output).toContain('[in_progress] T1: existing');
    expect(todos()).toEqual([todoItem('T1', 'existing', 'in_progress')]);
  });

  it('write mode replaces the list and defensively copies todos', async () => {
    const tool = ctx.get(ITodoListTool);
    const input: Array<{ title: string; status: TodoItem['status'] }> = [
      { title: 'first', status: 'pending' },
      { title: 'second', status: 'in_progress' },
    ];

    const result = await executeTool(tool, {
      turnId: 1,
      toolCallId: 'call_1',
      args: { todos: input },
      signal,
    });
    input[0] = { title: 'leaked', status: 'done' };

    expect(result).toMatchObject({ isError: false });
    expect(result.output).toContain('Todo list updated');
    expect(result.output).toContain('[pending] T1: first');
    expect(result.output).toContain('[in_progress] T2: second');
    expect(result.output).toContain(
      'Ensure that you continue to use the todo list to track progress.',
    );
    expect(result.output).toContain('exactly one task in_progress');
    expect(todos()).toEqual([
      todoItem('T1', 'first', 'pending'),
      todoItem('T2', 'second', 'in_progress'),
    ]);
  });

  it('renders a done todo with a marker matching the status enum value', async () => {
    await seed([todoItem('T1', 'shipped', 'done')]);
    const tool = ctx.get(ITodoListTool);

    const result = await executeTool(tool, {
      turnId: 1,
      toolCallId: 'call_1',
      args: {},
      signal,
    });

    expect(result).toMatchObject({ isError: false });
    expect(result.output).toContain('[done] T1: shipped');
    expect(result.output).not.toContain('[completed]');
  });

  it('clear mode empties the list without adding the progress-tracking reminder', async () => {
    await seed([todoItem('T1', 'x', 'pending')]);
    const tool = ctx.get(ITodoListTool);

    const result = await executeTool(tool, {
      turnId: 1,
      toolCallId: 'call_1',
      args: { todos: [] },
      signal,
    });

    expect(result).toMatchObject({ isError: false, output: 'Todo list cleared.' });
    expect(todos()).toEqual([]);
  });

  it('resolveExecution description reflects the mode', async () => {
    const tool = ctx.get(ITodoListTool);
    const readExecution = await tool.resolveExecution({});
    const clearExecution = await tool.resolveExecution({ todos: [] });
    const updateExecution = await tool.resolveExecution({
      todos: [{ title: 'x', status: 'pending' }],
    });

    if (
      readExecution.isError === true ||
      clearExecution.isError === true ||
      updateExecution.isError === true
    ) {
      throw new TypeError('expected runnable executions');
    }
    expect(readExecution.description).toBe('Reading todo list');
    expect(clearExecution.description).toBe('Clearing todo list');
    expect(updateExecution.description).toBe('Updating todo list');
  });
});
