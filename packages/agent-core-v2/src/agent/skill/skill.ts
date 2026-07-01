import { createDecorator } from "#/_base/di";
import type { ExecutableToolResult } from '#/agent/tool';
import type { Turn } from '#/agent/turn';

export interface SkillActivationInput {
  readonly name: string;
  readonly args?: string;
}

export interface ModelSkillActivationInput extends SkillActivationInput {
  readonly queryDepth?: number;
}

export interface IAgentSkillService {
  readonly _serviceBrand: undefined;

  activate(input: SkillActivationInput): Promise<Turn>;
  activateFromModel(input: ModelSkillActivationInput): Promise<ExecutableToolResult>;
}

export const IAgentSkillService =
  createDecorator<IAgentSkillService>('agentSkillService');
