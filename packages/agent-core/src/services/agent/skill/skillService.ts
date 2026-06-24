import { randomUUID } from 'node:crypto';

import type { ContentPart } from '@moonshot-ai/kosong';

import type { SkillActivationOrigin } from '../../../agent/context';
import { renderUserSlashSkillPrompt } from '../../../agent/skill/prompt';
import { Disposable, registerSingleton, SyncDescriptor } from '../../../di';
import { ErrorCodes, KimiError } from '../../../errors';
import type { EnabledPluginSessionStart } from '../../../plugin/types';
import {
  isUserActivatableSkillType,
  type SkillDefinition,
  type SkillRoot,
  type SkillSource,
} from '../../../skill';
import { SessionSkillRegistry } from '../../../skill/registry';
import { escapeXmlAttr } from '../../../utils/xml-escape';
import { IDynamicInjector } from '../dynamicInjector/dynamicInjector';
import { IEventBus } from '../eventBus/eventBus';
import { IPromptService } from '../prompt/prompt';
import { ITelemetryService } from '../telemetry/telemetry';
import type { ContextMessage, Turn } from '../types';
import { IWireRecord } from '../wireRecord/wireRecord';
import {
  IAgentSkillService,
  type AgentSkillServiceOptions,
  type SkillActivationInput,
} from './skill';

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

  interface WireRecordMap {
    'skill.activate': {
      origin: SkillActivationOrigin;
    };
  }
}

export class AgentSkillService extends Disposable implements IAgentSkillService {
  declare readonly _serviceBrand: undefined;

  private readonly registry: SessionSkillRegistry | undefined;
  private pluginSessionStarts: readonly EnabledPluginSessionStart[] = [];

  constructor(
    options: AgentSkillServiceOptions = {},
    @IPromptService private readonly prompt: IPromptService,
    @IEventBus private readonly events: IEventBus,
    @IDynamicInjector dynamicInjector: IDynamicInjector,
    @IWireRecord private readonly wireRecord: IWireRecord,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
    this.registry =
      options.registry === null ? undefined : (options.registry ?? new SessionSkillRegistry());
    this._register(
      this.wireRecord.register('skill.activate', (record) => {
        this.publishActivation(record.origin);
      }),
    );
    this._register(
      dynamicInjector.register('plugin_session_start', ({ injectedAt }) => {
        if (injectedAt !== null) return undefined;
        return this.pluginSessionStartReminder();
      }),
    );
  }

  async loadRoots(roots: readonly SkillRoot[]): Promise<void> {
    await this.registry?.loadRoots(roots);
  }

  setPluginSessionStarts(sessionStarts: readonly EnabledPluginSessionStart[]): void {
    this.pluginSessionStarts = [...sessionStarts];
  }

  registerBuiltinSkill(skill: SkillDefinition): void {
    this.registry?.registerBuiltinSkill(skill);
  }

  registerSkill(skill: SkillDefinition, options: { readonly replace?: boolean } = {}): void {
    this.registry?.register(skill, options);
  }

  listSkills(): readonly SkillDefinition[] {
    return this.registry?.listSkills() ?? [];
  }

  getModelSkillListing(): string {
    return this.registry?.getModelSkillListing() ?? '';
  }

  activate(input: SkillActivationInput): Turn {
    const skill = this.registry?.getSkill(input.name);
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

  recordActivation(
    origin: SkillActivationOrigin,
    input?: readonly ContentPart[],
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
    return this.prompt.prompt(message);
  }

  private renderSkillPrompt(skill: SkillDefinition, rawArgs: string): string {
    const registry = this.requireRegistry();
    return registry.renderSkillPrompt(skill, rawArgs);
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

  private requireRegistry(): SessionSkillRegistry {
    if (this.registry !== undefined) return this.registry;
    throw new KimiError(ErrorCodes.SKILL_NOT_FOUND, 'Skill registry is not available');
  }

  private pluginSessionStartReminder(): string | undefined {
    if (this.pluginSessionStarts.length === 0) return undefined;
    const registry = this.registry;
    if (registry === undefined) return undefined;
    const blocks: string[] = [];
    for (const sessionStart of this.pluginSessionStarts) {
      const skill = registry.getPluginSkill(sessionStart.pluginId, sessionStart.skillName);
      if (skill === undefined) continue;
      blocks.push(
        renderSessionStartBlock(
          sessionStart,
          skill,
          registry.renderSkillPrompt(skill, ''),
        ),
      );
    }
    return blocks.length === 0 ? undefined : blocks.join('\n');
  }
}

function renderSessionStartBlock(
  sessionStart: EnabledPluginSessionStart,
  skill: SkillDefinition,
  skillContent: string,
): string {
  return (
    `<plugin_session_start plugin="${escapeXmlAttr(sessionStart.pluginId)}" ` +
    `skill="${escapeXmlAttr(skill.name)}">\n${skillContent}\n</plugin_session_start>`
  );
}

registerSingleton(
  IAgentSkillService,
  new SyncDescriptor(AgentSkillService, [{}], true),
);
