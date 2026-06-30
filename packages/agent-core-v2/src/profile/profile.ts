import type {
  ChatProvider,
  ModelCapability,
  ProviderConfig,
} from '@moonshot-ai/kosong';

import { createDecorator } from "#/_base/di";
import type { ThinkingEffort } from '#/config/thinking';
import type { ToolSource } from '#/tool';

/**
 * Data required to configure an agent: provider, model, capabilities, profile,
 * thinking level, system prompt, and working directory. Owned by `profile`
 * (which assembles it); consumed by `replayBuilder` and `rpc` as a wire DTO.
 */
export interface AgentConfigData {
  cwd: string;
  provider?: ProviderConfig;
  modelAlias?: string;
  modelCapabilities: ModelCapability;
  profileName?: string;
  thinkingLevel: string;
  systemPrompt: string;
}

export type AgentConfigUpdateData = Partial<{
  cwd: string;
  modelAlias: string;
  profileName: string;
  thinkingLevel: string;
  systemPrompt: string;
}>;

export interface SystemPromptContext {
  readonly cwd?: string;
  readonly [key: string]: unknown;
}

export interface ResolvedAgentProfile {
  readonly name: string;
  readonly tools: readonly string[];
  systemPrompt(context: SystemPromptContext): string;
}

export interface ProfileData extends AgentConfigData {
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

export interface ProfileServiceOptions {
  readonly cwd?: string | (() => string | undefined);
  readonly chdir?: (cwd: string) => void | Promise<void>;
  readonly initializeBuiltinTools?: () => void;
  readonly emitStatusUpdated?: () => void;
}

export interface ProfileModelContext {
  readonly provider: ProviderConfig;
  readonly modelAlias: string;
  readonly modelCapabilities: ModelCapability;
  readonly maxOutputSize: number | undefined;
  readonly alwaysThinking: boolean | undefined;
  readonly thinkingLevel: ThinkingEffort;
  readonly reservedContextSize: number | undefined;
  readonly compactionTriggerRatio: number | undefined;
}

export interface ProfileSetModelResult {
  readonly model: string;
  readonly providerName?: string | undefined;
}

export interface IAgentProfileService {
  readonly _serviceBrand: undefined;
  configure(options: ProfileServiceOptions): void;
  update(changed: ProfileUpdateData): void;
  setModel(model: string): ProfileSetModelResult;
  setThinking(level: string): void;
  getModel(): string;
  useProfile(profile: ResolvedAgentProfile, context: SystemPromptContext): void;
  data(): ProfileData;
  resolveModelContext(): ProfileModelContext;
  getProvider(): ChatProvider;
  /**
   * The resolved chat provider for the active model. Equivalent to
   * {@link getProvider}, exposed as a property so media/video tooling (and
   * tests) can read or override the upload-capable provider directly.
   */
  readonly provider: ChatProvider;
  getModelCapabilities(): ModelCapability;
  getMaxOutputSize(): number | undefined;
  hasModel(): boolean;
  hasProvider(): boolean;
  getSystemPrompt(): string;
  getActiveToolNames(): readonly string[] | undefined;
  isToolActive(name: string, source?: ToolSource): boolean;
  addActiveTool(name: string): void;
  removeActiveTool(name: string): void;
}

export const IAgentProfileService = createDecorator<IAgentProfileService>('agentProfileService');
