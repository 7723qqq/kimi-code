import type { ResolvedAgentProfile, SystemPromptContext } from '../../../profile';
import { createDecorator } from '../../../di';

export interface ProfileData {
  readonly cwd?: string;
  readonly modelAlias?: string;
  readonly profileName?: string;
  readonly thinkingLevel?: string;
  readonly systemPrompt?: string;
  readonly activeToolNames?: readonly string[];
}

export type ProfileUpdateData = Partial<{
  cwd: string;
  modelAlias: string;
  profileName: string;
  thinkingLevel: string;
  systemPrompt: string;
  activeToolNames: readonly string[];
}>;

export interface IProfileService {
  update(changed: ProfileUpdateData): void;
  useProfile(profile: ResolvedAgentProfile, context: SystemPromptContext): void;
  data(): ProfileData;
  getSystemPrompt(): string;
  getActiveToolNames(): readonly string[] | undefined;
  isToolActive(name: string): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IProfileService = createDecorator<IProfileService>('profileService.agent');
