import { createDecorator } from "#/_base/di";
import type { ContextMessage } from "#/contextMemory";
import type { Turn } from "#/turn";


export interface IAgentPromptService {
  readonly _serviceBrand: undefined;
  prompt(message: ContextMessage): Turn | undefined;
  steer(message: ContextMessage): Turn | undefined;
  retry(trigger?: string): Turn | undefined;
  undo(count: number): number;
  clear(): void;
}

export const IAgentPromptService = createDecorator<IAgentPromptService>('agentPromptService');
