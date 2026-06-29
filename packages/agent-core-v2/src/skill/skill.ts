import { createDecorator } from "#/_base/di";
import type { ExecutableToolResult } from '#/_base/tools';
import type { Turn } from '#/turn';
import type { SkillCatalog } from './types';

export interface SkillActivationInput {
  readonly name: string;
  readonly args?: string;
}

export interface ModelSkillActivationInput extends SkillActivationInput {
  readonly queryDepth?: number;
}

export interface AgentSkillServiceOptions {
  readonly catalog?: SkillCatalog | null;
}

export interface IAgentSkillService {
  readonly _serviceBrand: undefined;

  activate(input: SkillActivationInput): Turn;
  activateFromModel(input: ModelSkillActivationInput): ExecutableToolResult;
}

export const IAgentSkillService =
  createDecorator<IAgentSkillService>('agentSkillService');
