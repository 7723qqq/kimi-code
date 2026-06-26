import { createDecorator } from "#/_base/di";

export interface ITodoListService {
  readonly _serviceBrand: undefined;
}

export const ITodoListService = createDecorator<ITodoListService>('agentTodoListService');
