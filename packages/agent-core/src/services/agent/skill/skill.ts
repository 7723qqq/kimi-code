import type { ContentPart } from '@moonshot-ai/kosong';

import type { SkillActivationOrigin } from '../../../agent/context';
import { createDecorator } from '../../../di';
import type { EnabledPluginSessionStart } from '../../../plugin/types';
import type { SkillDefinition, SkillRoot } from '../../../skill';
import type { SessionSkillRegistry } from '../../../skill/registry';
import type { Turn } from '../types';

export interface SkillActivationInput {
  readonly name: string;
  readonly args?: string;
}

export interface AgentSkillServiceOptions {
  readonly registry?: SessionSkillRegistry | null;
}

export interface IAgentSkillService {
  readonly _serviceBrand: undefined;

  loadRoots(roots: readonly SkillRoot[]): Promise<void>;
  setPluginSessionStarts(sessionStarts: readonly EnabledPluginSessionStart[]): void;
  registerBuiltinSkill(skill: SkillDefinition): void;
  registerSkill(skill: SkillDefinition, options?: { readonly replace?: boolean }): void;
  listSkills(): readonly SkillDefinition[];
  getModelSkillListing(): string;
  activate(input: SkillActivationInput): Turn;
  recordActivation(
    origin: SkillActivationOrigin,
    input?: readonly ContentPart[],
  ): Turn | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IAgentSkillService =
  createDecorator<IAgentSkillService>('agentSkillService');
