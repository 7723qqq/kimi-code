import type { ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';

import {
  agentContextOfScope,
  IAgentScopeContext,
} from '#/agent/scopeContext/scopeContext';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import {
  TODO_LIST_TOOL_NAME,
  renderTodoList,
  type TodoItem,
} from '#/session/todo/todoItem';

import {
  ITodoListTool,
  TodoListInputSchema,
  type TodoListInput,
} from './todo-list';
import DESCRIPTION from './todo-list.md?raw';
import TODO_LIST_WRITE_REMINDER from './todo-list-write-reminder.md?raw';

export class TodoListTool implements ITodoListTool {
  declare readonly _serviceBrand: undefined;
  readonly name = TODO_LIST_TOOL_NAME;
  readonly description: string = DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TodoListInputSchema);

  constructor(
    @ISessionTodoService private readonly todo: ISessionTodoService,
    @IAgentScopeContext private readonly agent: IAgentScopeContext,
  ) {}

  resolveExecution(args: TodoListInput): ToolExecution {
    const description =
      args.todos !== undefined
        ? args.todos.length === 0
          ? 'Clearing todo list'
          : 'Updating todo list'
        : args.updates !== undefined
          ? 'Applying incremental todo updates'
          : 'Reading todo list';
    return {
      description,
      approvalRule: this.name,
      execute: async () => {
        const agent = agentContextOfScope(this.agent);
        if (args.todos === undefined && args.updates === undefined) {
          const todos = await this.todo.getTodos(agent);
          return { isError: false, output: renderTodoList(todos) };
        }

        let next: readonly TodoItem[];
        if (args.todos !== undefined && args.updates !== undefined) {
          return {
            isError: true,
            output:
              'TodoList accepts either `todos` (replace the list) or `updates` (patch by id), not both. Pass one or the other.',
          };
        }
        if (args.updates !== undefined) {
          const current = await this.todo.getTodos(agent);
          try {
            next = applyTodoUpdates(current, args.updates);
          } catch (error) {
            return {
              isError: true,
              output: error instanceof Error ? error.message : String(error),
            };
          }
        } else {
          next = args.todos!.map((todo) => ({
            id: todo.id ?? '',
            parentId: todo.parentId ?? null,
            kind: todo.kind ?? 'task',
            title: todo.title,
            status: todo.status,
            progress: todo.progress,
            description: todo.description,
          }));
        }
        await this.todo.setTodos(agent, next);
        const stored = await this.todo.getTodos(agent);
        const output =
          stored.length === 0
            ? 'Todo list cleared.'
            : `Todo list updated.\n${renderTodoList(stored)}\n\n${TODO_LIST_WRITE_REMINDER.trim()}`;
        return { isError: false, output };
      },
    };
  }
}

/**
 * Merge incremental patches into the current list by id. Only the fields
 * present on a patch change; unknown ids surface as an error naming the
 * current ids so the model can recover with a query or a full rewrite.
 */
function applyTodoUpdates(
  current: readonly TodoItem[],
  patches: TodoListInput['updates'],
): readonly TodoItem[] {
  if (patches === undefined || patches.length === 0) return current;
  const byId = new Map(current.map((item) => [item.id, item]));
  const unknown = patches
    .map((patch) => patch.id)
    .filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown todo id${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. ` +
        `Current ids: ${[...byId.keys()].join(', ') || '(empty list)'}. ` +
        'Query the list (omit todos/updates) to see its current state, or rewrite it with todos.',
    );
  }
  return current.map((item) => {
    const patch = patches.find((candidate) => candidate.id === item.id);
    if (patch === undefined) return item;
    return {
      id: item.id,
      parentId: patch.parentId !== undefined ? patch.parentId : item.parentId,
      kind: patch.kind ?? item.kind,
      title: patch.title ?? item.title,
      status: patch.status ?? item.status,
      progress:
        patch.progress !== undefined ? patch.progress : item.progress,
      description: patch.description !== undefined ? patch.description : item.description,
    };
  });
}
