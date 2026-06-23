import { randomUUID } from 'node:crypto';

import type { ContentPart } from '@moonshot-ai/kosong';

import type { SkillActivationOrigin } from '../../../agent/context';
import { renderUserSlashSkillPrompt } from '../../../agent/skill/prompt';
import type { SkillRegistry } from '../../../agent/skill/types';
import { ErrorCodes, KimiError } from '../../../errors';
import {
  isUserActivatableSkillType,
  type SkillDefinition,
  type SkillRoot,
  type SkillSource,
} from '../../../skill';
import { SessionSkillRegistry } from '../../../skill/registry';
import { IPromptService } from '../prompt/prompt';
import { IEventBus } from '../eventBus/eventBus';
import type { ContextMessage, Turn } from '../types';

export interface SkillActivationInput {
  readonly name: string;
  readonly args?: string;
}

declare module '../types' {
  interface AgentEventMap {
    'skill.activated': {
      activationId: string;
      skillName: string;
      trigger: SkillActivationOrigin['trigger'];
      skillArgs?: string;
      skillPath?: string;
      skillSource?: SkillSource;
    };
  }
}

export class Skill implements SkillRegistry {
  private readonly registry = new SessionSkillRegistry();

  constructor(
    @IPromptService private readonly prompt: IPromptService,
    @IEventBus private readonly events: IEventBus,
  ) {}

  async loadRoots(roots: readonly SkillRoot[]): Promise<void> {
    await this.registry.loadRoots(roots);
  }

  registerSkill(skill: SkillDefinition, options: { readonly replace?: boolean } = {}): void {
    this.registry.register(skill, options);
  }

  getSkill(name: string): SkillDefinition | undefined {
    return this.registry.getSkill(name);
  }

  getPluginSkill(pluginId: string, name: string): SkillDefinition | undefined {
    return this.registry.getPluginSkill(pluginId, name);
  }

  renderSkillPrompt(skill: SkillDefinition, rawArgs: string): string {
    return this.registry.renderSkillPrompt(skill, rawArgs);
  }

  listSkills(): readonly SkillDefinition[] {
    return this.registry.listSkills();
  }

  listInvocableSkills(): readonly SkillDefinition[] {
    return this.registry.listInvocableSkills();
  }

  getSkillRoots(): readonly string[] {
    return this.registry.getSkillRoots();
  }

  getModelSkillListing(): string {
    return this.registry.getModelSkillListing();
  }

  activate(input: SkillActivationInput): Turn {
    const skill = this.registry.getSkill(input.name);
    if (skill === undefined) {
      throw new KimiError(ErrorCodes.SKILL_NOT_FOUND, `Skill "${input.name}" was not found`);
    }
    if (!isUserActivatableSkillType(skill.metadata.type)) {
      throw new KimiError(
        ErrorCodes.SKILL_TYPE_UNSUPPORTED,
        `Skill "${skill.name}" cannot be activated by the user`,
      );
    }

    const skillArgs = input.args ?? '';
    const skillContent = this.registry.renderSkillPrompt(skill, skillArgs);
    const content: ContentPart[] = [
      {
        type: 'text',
        text: renderUserSlashSkillPrompt({
          skillName: skill.name,
          skillArgs,
          skillContent,
          skillSource: skill.source,
          skillDir: skill.dir,
        }),
      },
    ];

    return this.recordActivation(
      {
        kind: 'skill_activation',
        activationId: randomUUID(),
        skillName: skill.name,
        trigger: 'user-slash',
        skillType: skill.metadata.type,
        skillPath: skill.path,
        skillSource: skill.source,
        skillArgs: input.args,
      },
      content,
    )!;
  }

  recordActivation(
    origin: SkillActivationOrigin,
    input?: readonly ContentPart[],
  ): Turn | undefined {
    this.events.emit({
      type: 'skill.activated',
      activationId: origin.activationId,
      skillName: origin.skillName,
      trigger: origin.trigger,
      skillArgs: origin.skillArgs,
      skillPath: origin.skillPath,
      skillSource: origin.skillSource,
    });

    if (input === undefined) return undefined;
    const message: ContextMessage = {
      role: 'user',
      content: [...input],
      toolCalls: [],
      origin,
    };
    return this.prompt.prompt(message);
  }
}
