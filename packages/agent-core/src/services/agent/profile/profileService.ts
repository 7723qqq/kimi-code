import { registerSingleton, SyncDescriptor } from '../../../di';
import type { ResolvedAgentProfile, SystemPromptContext } from '../../../profile';

import { IEventBus } from '../eventBus/eventBus';
import type { ProfileData, ProfileUpdateData } from './profile';
import { IProfileService } from './profile';
import { IReplayBuilderService } from '../replayBuilder/replayBuilder';
import { IWireRecord } from '../wireRecord/wireRecord';

declare module '../types' {
  interface WireRecordMap {
    'config.update': ProfileUpdateData;
  }

  interface AgentEventMap {
    'config.updated': {
      changed: ProfileUpdateData;
      data: ProfileData;
    };
  }
}

export class ProfileService implements IProfileService {
  private cwd: string | undefined;
  private modelAlias: string | undefined;
  private profileName: string | undefined;
  private thinkingLevel: string | undefined;
  private systemPrompt = '';
  private activeToolNames: readonly string[] | undefined;

  constructor(
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IEventBus private readonly events: IEventBus,
    @IReplayBuilderService private readonly replayBuilder: IReplayBuilderService,
  ) {
    wireRecord.register('config.update', (record) => {
      const { type: _type, time: _time, ...changed } = record;
      this.apply(changed);
    });
  }

  update(changed: ProfileUpdateData): void {
    if (Object.keys(changed).length === 0) return;
    this.wireRecord.append({ type: 'config.update', ...changed });
    this.apply(changed);
  }

  useProfile(profile: ResolvedAgentProfile, context: SystemPromptContext): void {
    this.update({
      profileName: profile.name,
      systemPrompt: profile.systemPrompt(context),
      activeToolNames: profile.tools,
    });
  }

  data(): ProfileData {
    return {
      cwd: this.cwd,
      modelAlias: this.modelAlias,
      profileName: this.profileName,
      thinkingLevel: this.thinkingLevel,
      systemPrompt: this.systemPrompt,
      activeToolNames: this.activeToolNames === undefined ? undefined : [...this.activeToolNames],
    };
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  getActiveToolNames(): readonly string[] | undefined {
    return this.activeToolNames;
  }

  isToolActive(name: string): boolean {
    const activeToolNames = this.activeToolNames;
    if (activeToolNames === undefined) return true;
    return activeToolNames.some((pattern) => toolNameMatches(pattern, name));
  }

  private apply(changed: ProfileUpdateData): void {
    this.replayBuilder.push({ type: 'config_updated', config: changed });
    if (changed.cwd !== undefined) this.cwd = changed.cwd;
    if (changed.modelAlias !== undefined) this.modelAlias = changed.modelAlias;
    if (changed.profileName !== undefined) this.profileName = changed.profileName;
    if (changed.thinkingLevel !== undefined) this.thinkingLevel = changed.thinkingLevel;
    if (changed.systemPrompt !== undefined) this.systemPrompt = changed.systemPrompt;
    if (changed.activeToolNames !== undefined) {
      this.activeToolNames = [...changed.activeToolNames];
    }
    this.events.emit({ type: 'config.updated', changed, data: this.data() });
  }
}

function toolNameMatches(pattern: string, name: string): boolean {
  if (!pattern.includes('*')) return pattern === name;
  const escaped = pattern.replaceAll(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(name);
}

registerSingleton(IProfileService, new SyncDescriptor(ProfileService, [], true));
