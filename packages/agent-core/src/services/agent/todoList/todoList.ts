import { createDecorator } from '../../../di';
import type { TodoItem } from '../../../tools/builtin/state/todo-list';

export interface ITodoListService {
  readonly _serviceBrand: undefined;

  getTodos(): readonly TodoItem[];
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ITodoListService = createDecorator<ITodoListService>('agentTodoListService');
