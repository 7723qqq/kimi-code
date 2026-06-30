import { createDecorator } from "#/_base/di";

export interface IAgentTodoListService {
  readonly _serviceBrand: undefined;
}

export const IAgentTodoListService = createDecorator<IAgentTodoListService>('agentTodoListService');
