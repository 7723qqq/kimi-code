import { createDecorator } from "#/_base/di";
import type { Turn } from '#/agent/turn';

export interface SkillActivationInput {
  readonly name: string;
  readonly args?: string;
}

export interface IAgentSkillService {
  readonly _serviceBrand: undefined;

  activate(input: SkillActivationInput): Promise<Turn>;
}

export const IAgentSkillService =
  createDecorator<IAgentSkillService>('agentSkillService');
