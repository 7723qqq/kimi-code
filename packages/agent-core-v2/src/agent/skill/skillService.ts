/**
 * `skill` domain (L3) — `IAgentSkillService` implementation.
 *
 * Owns user-slash skill activation (opens a fresh turn) and the shared
 * activation recording used by the model-tool path: resolves skills from the
 * Session `sessionSkillCatalog`, renders their prompts with the Session
 * `sessionContext` `sessionId`, delivers the rendered message through `prompt`,
 * and records/publishes activations through `record` and `telemetry`. Bound at
 * Agent scope.
 */

import { randomUUID } from 'node:crypto';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import type { ContentPart } from '#/app/llmProtocol';

import type { ContextMessage, SkillActivationOrigin } from '#/agent/contextMemory';
import { renderUserSlashSkillPrompt } from './prompt';
import { Disposable } from "#/_base/di";
import { ErrorCodes, KimiError } from "#/errors";
import { isUserActivatableSkillType, type SkillDefinition } from '#/app/skillCatalog/types';
import { IAgentPromptService } from '#/agent/prompt';
import { ITelemetryService } from '#/app/telemetry';
import type { Turn } from '#/agent/turn';
import { IAgentRecordService } from '#/agent/record';
import { ISessionContext } from '#/session/sessionContext';
import { IAgentSkillService, type SkillActivationInput } from './skill';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';

declare module '#/agent/wireRecord' {
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
    @IAgentRecordService private readonly records: IAgentRecordService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ISessionContext private readonly sessionContext: ISessionContext,
  ) {
    super();
    this._register(
      records.define('skill.activate', {
        resume: (r) => {
          this.publishActivation(r.origin);
        },
      }),
    );
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

    const turn = await this.recordActivation(
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
    );
    if (turn === undefined) {
      throw new KimiError(
        ErrorCodes.TURN_AGENT_BUSY,
        'Cannot activate skill while another turn is active',
      );
    }
    return turn;
  }

  recordModelToolActivation(origin: SkillActivationOrigin): void {
    void this.recordActivation(origin);
  }

  private async recordActivation(
    origin: SkillActivationOrigin,
    input?: readonly ContentPart[],
  ): Promise<Turn | undefined> {
    this.records.append({ type: 'skill.activate', origin });
    this.publishActivation(origin);

    if (input === undefined) return undefined;
    const message: ContextMessage = {
      role: 'user',
      content: [...input],
      toolCalls: [],
      origin,
    };
    return this.prompt.prompt(message);
  }

  private renderSkillPrompt(skill: SkillDefinition, rawArgs: string): string {
    return this.skillCatalog.catalog.renderSkillPrompt(skill, rawArgs, {
      sessionId: this.sessionContext.sessionId,
    });
  }

  private publishActivation(origin: SkillActivationOrigin): void {
    this.records.signal({
      type: 'skill.activated',
      activationId: origin.activationId,
      skillName: origin.skillName,
      trigger: origin.trigger,
      skillArgs: origin.skillArgs,
      skillPath: origin.skillPath,
      skillSource: origin.skillSource,
    });
    if (this.records.restoring !== null) return;
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

registerScopedService(
  LifecycleScope.Agent,
  IAgentSkillService,
  AgentSkillService,
  InstantiationType.Delayed,
  'skill',
);
