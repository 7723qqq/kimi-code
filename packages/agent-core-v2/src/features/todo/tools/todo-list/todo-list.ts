import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type TodoStatus } from '#/features/todo/todoItem';
import { type AgentTool } from '#/tool/toolContract';

const TodoItemSchema = z.object({
  id: z
    .string()
    .optional()
    .describe(
      'Stable identifier of the item, as returned by a previous call. Reuse it so an update lands on the same item instead of creating a new one. Omit on first write; missing ids are assigned as T1, T1.1, and so on.',
    ),
  parentId: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Id of the milestone this item belongs to. Null or omitted for milestones and for a flat list.',
    ),
  kind: z
    .enum(['milestone', 'task'])
    .optional()
    .describe('Milestone groups leaf tasks; task is a leaf unit of work. Defaults to task.'),
  title: z.string().min(1).describe('Short, actionable title for the todo.'),
  status: z.enum(['pending', 'in_progress', 'done']).describe('Current status of the todo.'),
  progress: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe(
      'Completion percentage 0-100 of an in_progress leaf task. Omit on milestones (computed from children) and on done items (implies 100).',
    ),
  description: z.string().optional().describe('Optional longer note about the item.'),
});

export interface TodoListInput {
  todos?: Array<{
    id?: string;
    parentId?: string | null;
    kind?: 'milestone' | 'task';
    title: string;
    status: TodoStatus;
    progress?: number;
    description?: string;
  }>;
}

export const TodoListInputSchema: z.ZodType<TodoListInput> = z.object({
  todos: z
    .array(TodoItemSchema)
    .optional()
    .describe(
      'The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.',
    ),
});

export interface ITodoListTool extends AgentTool<TodoListInput> {
  readonly _serviceBrand: undefined;
}
export const ITodoListTool = createDecorator<ITodoListTool>('todoListTool');
