import {
  randomUUID } from 'node:crypto';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import type { ContentPart } from '@moonshot-ai/kosong';

import type { ContextMessage, SkillActivationOrigin } from '#/contextMemory';
import {
  renderModelToolSkillPrompt,
  renderUserSlashSkillPrompt,
} from './prompt';
import { Disposable,
} from "#/_base/di";
import { ErrorCodes, KimiError } from "#/errors";
import type { ExecutableToolResult } from '#/tool';
import {
  isInlineSkillType,
  isUserActivatableSkillType,
  type SkillDefinition,
} from './types';
import { IAgentEventSinkService } from '../eventSink';
import { IAgentPromptService } from '#/prompt';
import { ITelemetryService } from '#/telemetry';
import { IAgentToolRegistryService } from '#/toolRegistry';
import type { Turn } from '#/turn';
import { IAgentWireRecordService } from '#/wireRecord';
import {
  IAgentSkillService,
  type ModelSkillActivationInput,
  type SkillActivationInput,
} from './skill';
import { ISessionSkillCatalog } from './skillCatalog';
import { SkillTool } from './tools/skill';

declare module '#/wireRecord' {
  interface WireRecordMap {
    'skill.activate': {
      origin: SkillActivationOrigin;
    };
  }
}

export class AgentSkillService extends Disposable implements IAgentSkillService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionSkillCatalog private readonly skillCatalog: ISessionSkillCatalog,
    @IAgentPromptService private readonly prompt: IAgentPromptService,
    @IAgentEventSinkService private readonly events: IAgentEventSinkService,
    @IAgentWireRecordService private readonly wireRecord: IAgentWireRecordService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
  ) {
    super();
    this._register(
      this.wireRecord.register('skill.activate', (record) => {
        this.publishActivation(record.origin);
      }),
    );
    this._register(toolRegistry.register(new SkillTool(this)));
  }

  async activate(input: SkillActivationInput): Promise<Turn> {
    await this.skillCatalog.ready;
    const skill = this.skillCatalog.catalog.getSkill(input.name);
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
    const skillContent = this.renderSkillPrompt(skill, skillArgs);
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

  async activateFromModel(input: ModelSkillActivationInput): Promise<ExecutableToolResult> {
    await this.skillCatalog.ready;
    const skill = this.skillCatalog.catalog.getSkill(input.name);
    if (skill === undefined) {
      return errorResult(`Skill "${input.name}" not found in the current skill listing.`);
    }
    if (skill.metadata.disableModelInvocation === true) {
      return errorResult(
        `Skill "${input.name}" can only be triggered by the user (model invocation is disabled).`,
      );
    }
    if (!isInlineSkillType(skill.metadata.type)) {
      return errorResult(
        `Skill "${skill.name}" is not an inline skill and cannot be invoked by the model in v1.`,
      );
    }

    const skillArgs = input.args ?? '';
    const queryDepth = input.queryDepth ?? 0;
    const trigger = queryDepth > 0 ? 'nested-skill' : 'model-tool';
    const origin: SkillActivationOrigin = {
      kind: 'skill_activation',
      activationId: randomUUID(),
      skillName: skill.name,
      skillArgs: skillArgs.length > 0 ? skillArgs : undefined,
      trigger,
      skillType: skill.metadata.type,
      skillPath: skill.path,
      skillSource: skill.source,
    };
    const skillContent = this.renderSkillPrompt(skill, skillArgs);
    this.recordActivation(
      origin,
      [
        {
          type: 'text',
          text: renderModelToolSkillPrompt({
            skillName: skill.name,
            skillArgs,
            skillContent,
            skillSource: skill.source,
            skillDir: skill.dir,
            trigger,
          }),
        },
      ],
      'steer',
    );
    return {
      output: `Skill "${skill.name}" loaded inline. Follow its instructions.`,
    };
  }

  private recordActivation(
    origin: SkillActivationOrigin,
    input?: readonly ContentPart[],
    delivery: 'prompt' | 'steer' = 'prompt',
  ): Turn | undefined {
    this.wireRecord.append({ type: 'skill.activate', origin });
    this.publishActivation(origin);

    if (input === undefined) return undefined;
    const message: ContextMessage = {
      role: 'user',
      content: [...input],
      toolCalls: [],
      origin,
    };
    return delivery === 'steer' ? this.prompt.steer(message) : this.prompt.prompt(message);
  }

  private renderSkillPrompt(skill: SkillDefinition, rawArgs: string): string {
    return this.skillCatalog.catalog.renderSkillPrompt(skill, rawArgs);
  }

  private publishActivation(origin: SkillActivationOrigin): void {
    this.events.emit({
      type: 'skill.activated',
      activationId: origin.activationId,
      skillName: origin.skillName,
      trigger: origin.trigger,
      skillArgs: origin.skillArgs,
      skillPath: origin.skillPath,
      skillSource: origin.skillSource,
    });
    if (this.wireRecord.restoring !== null) return;
    this.telemetry.track('skill_invoked', {
      skill_name: origin.skillName,
      trigger: origin.trigger,
    });
    if (origin.skillType === 'flow') {
      this.telemetry.track('flow_invoked', {
        flow_name: origin.skillName,
      });
    }
  }
}

function errorResult(message: string): ExecutableToolResult {
  return { isError: true, output: message };
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentSkillService,
  AgentSkillService,
  InstantiationType.Delayed,
  'skill',
);
