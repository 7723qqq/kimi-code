import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type TodoStatus } from '#/session/todo/todoItem';
import { type AgentTool } from '#/tool/toolContract';

const TodoItemSchema = z.object({
  id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Stable task id. Top-level: "T1", "T2", …; children: "T1.1", "T1.2", …. Auto-assigned when omitted.',
    ),
  parentId: z
    .string()
    .nullable()
    .optional()
    .describe('Parent task id for hierarchy, null or omitted for top-level items.'),
  kind: z
    .enum(['milestone', 'task'])
    .optional()
    .describe(
      '"milestone" marks a stage checkpoint (start / middle milestones / finish); "task" (default) is a fine-grained leaf.',
    ),
  title: z.string().min(1).describe('Short, actionable title for the todo.'),
  status: z.enum(['pending', 'in_progress', 'done']).describe('Current status of the todo.'),
  progress: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe(
      'Leaf-task completion percent. Report on in_progress items as work advances; milestone progress is computed from children automatically.',
    ),
  description: z.string().optional().describe('Optional longer description or context.'),
});

const TodoItemPatchSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe('Id of an existing todo item to update in place.'),
  parentId: z
    .string()
    .nullable()
    .optional()
    .describe('New parent task id, null or omitted to keep the current parent.'),
  kind: z
    .enum(['milestone', 'task'])
    .optional()
    .describe('New kind for the item.'),
  title: z
    .string()
    .min(1)
    .optional()
    .describe('New short, actionable title.'),
  status: z
    .enum(['pending', 'in_progress', 'done'])
    .optional()
    .describe('New status.'),
  progress: z
    .number()
    .int()
    .min(0)
    .max(100)
    .optional()
    .describe('New leaf completion percent (0-100).'),
  description: z
    .string()
    .optional()
    .describe('New longer description or context.'),
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
  updates?: Array<{
    id: string;
    parentId?: string | null;
    kind?: 'milestone' | 'task';
    title?: string;
    status?: TodoStatus;
    progress?: number;
    description?: string;
  }>;
}

export const TodoListInputSchema: z.ZodType<TodoListInput> = z.object({
  todos: z
    .array(TodoItemSchema)
    .optional()
    .describe(
      'The updated todo list with hierarchy. Omit to read the current todo list without making changes. Pass an empty array to clear the list. Mutually exclusive with updates.',
    ),
  updates: z
    .array(TodoItemPatchSchema)
    .optional()
    .describe(
      'Incremental updates: each entry patches one existing item by id (only the provided fields change). Mutually exclusive with todos. Cheaper than rewriting the whole list, so prefer it for small status/progress changes. Pass an empty array to no-op.' +
        ' Keep the list fine-grained — every leaf is one minimal, independently verifiable unit — and report progress as you advance.',
    ),
});

export interface ITodoListTool extends AgentTool<TodoListInput> {
  readonly _serviceBrand: undefined;
}
export const ITodoListTool = createDecorator<ITodoListTool>('todoListTool');
