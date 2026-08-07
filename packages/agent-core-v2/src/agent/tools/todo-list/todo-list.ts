/**
 * `tools` domain — `ITodoListTool` contract (the `TodoList` tool).
 *
 * Public contract of the structured TODO list tool. A single input schema
 * serves both reads and writes:
 *
 *   - `{ todos: [...] }` — replace the full list
 *   - `{ todos: [] }`    — clear the list
 *   - `{}`               — query the current list
 *
 * Exports the model-facing `TodoListInputSchema` / `TodoListInput` and the
 * `ITodoListTool` DI decorator. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';
import { type TodoStatus } from '#/session/todo/todoItem';

const TodoItemSchema = z.object({
  id: z
    .string()
    .describe(
      'Unique task ID. Top-level: "T1", "T2", …. Children: "T1.1", "T1.2", …. Auto-assigned if omitted.',
    ),
  parentId: z
    .string()
    .nullable()
    .describe('Parent task ID for hierarchy, or null for top-level tasks.'),
  title: z.string().min(1).describe('Short, actionable title for the task.'),
  status: z
    .enum(['open', 'in_progress', 'blocked', 'done', 'abandoned'])
    .describe('Current status of the task.'),
  description: z
    .string()
    .optional()
    .describe('Optional longer description or context for the task.'),
});

export interface TodoListInput {
  todos?: Array<{
    id: string;
    parentId: string | null;
    title: string;
    status: TodoStatus;
    description?: string;
  }>;
}

export const TodoListInputSchema: z.ZodType<TodoListInput> = z.object({
  todos: z
    .array(TodoItemSchema)
    .optional()
    .describe(
      'The updated task list with hierarchy. Omit to read the current list without making changes. Pass an empty array to clear the list.',
    ),
});

export interface ITodoListTool extends AgentTool<TodoListInput> {
  readonly _serviceBrand: undefined;
}
export const ITodoListTool = createDecorator<ITodoListTool>('todoListTool');
