import type { TodoId } from './ids';

export type TodoStatus = 'pending' | 'in_progress' | 'done';
export type TodoKind = 'milestone' | 'task';

export interface TodoItem {
  readonly id?: string;
  readonly parentId?: string | null;
  readonly kind?: TodoKind;
  readonly title: string;
  readonly status: TodoStatus;
  readonly progress?: number;
}

export interface TranscriptTodo {
  readonly todoId: TodoId;
  readonly items: readonly TodoItem[];
  readonly updatedAt?: string;
}
