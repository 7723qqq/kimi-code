import { createDecorator } from '../../../di';
import type { SkillCatalog } from '../../../skill';
import type { Turn } from '../types';

export interface SkillActivationInput {
  readonly name: string;
  readonly args?: string;
}

export interface AgentSkillServiceOptions {
  readonly catalog?: SkillCatalog | null;
}

export interface IAgentSkillService {
  readonly _serviceBrand: undefined;

  activate(input: SkillActivationInput): Turn;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IAgentSkillService =
  createDecorator<IAgentSkillService>('agentSkillService');
