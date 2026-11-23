import { createDecorator } from '#/_base/di/instantiation';
import { Error2 } from '#/_base/errors/errors';
import type {
  AgentProfile,
  AgentProfileContext,
  EnvironmentDisclosureSnapshot,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import type { ErrorCode } from '#/errors';
import type { ModelCapability } from '#/llm-adapter/contract/capability';
import type { ProfileUpdatePlan } from './profileOps';
import type { ModelRequestParams } from '#/llm-adapter/model/model-requester';
import type { ThinkingEffort } from '#human/llm/thinking';

import type { ProfileErrors } from './errors';

export { ProfileErrors } from './errors';

export type ProfileErrorCode = (typeof ProfileErrors.codes)[keyof typeof ProfileErrors.codes];

export class ProfileError extends Error2 {
  constructor(code: ProfileErrorCode, message: string, details?: Record<string, unknown>) {
    super(code as ErrorCode, message, { details });
    this.name = 'ProfileError';
  }
}

export interface AgentConfigData {
  modelAlias?: string;
  modelCapabilities: ModelCapability;
  profileName?: string;
  thinkingLevel: string;
  systemPrompt: string;
}

export type AgentConfigUpdateData = Partial<{
  modelAlias: string;
  profileName: string;
  thinkingLevel: string;
  systemPrompt: string;
}>;

export interface SystemPromptContext extends AgentProfileContext {
  readonly agentsMdWarning?: string;
  readonly agentsMdPaths?: readonly string[];
}

export type ResolvedAgentProfile = AgentProfile;

export interface ProfileData extends AgentConfigData {
  readonly agentsMdPaths?: readonly string[];
  readonly activeToolNames?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
  readonly environmentDisclosure?: EnvironmentDisclosureSnapshot;
  readonly renderGeneration?: number;
}

export type ProfileUpdateData = Partial<{
  modelAlias: string;
  profileName: string;
  thinkingLevel: string;
  systemPrompt: string;
  environmentDisclosure: EnvironmentDisclosureSnapshot;
  agentsMdPaths: readonly string[];
  disallowedTools: readonly string[];
  activeToolNames: readonly string[];
}>;

export interface ProfileBindingSnapshot {
  readonly modelAlias?: string;
  readonly profileName?: string;
  readonly thinkingLevel: string;
  readonly systemPrompt: string;
  readonly environmentDisclosure?: EnvironmentDisclosureSnapshot;
  readonly renderGeneration?: number;
  readonly agentsMdPaths?: readonly string[];
  readonly activeToolNames?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly subagents?: readonly string[];
}

export interface ProfileServiceOptions {
  readonly emitStatusUpdated?: () => void;
}

export interface ApplyProfileOptions {
  readonly additionalDirs?: readonly string[];
}

export interface ProfileModelContext {
  readonly modelAlias: string;
  readonly modelCapabilities: ModelCapability;
  readonly maxOutputSize: number | undefined;
  readonly alwaysThinking: boolean | undefined;
  readonly thinkingLevel: ThinkingEffort;
  readonly reservedContextSize: number | undefined;
  readonly compactionTriggerRatio: number | undefined;
  readonly compactionMaxAttempts: number | undefined;
}

export interface ProfileSetModelResult {
  readonly model: string;
  readonly providerName?: string | undefined;
}

export interface BindAgentInput {
  readonly profile: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly strictThinking?: boolean;
}

export interface IAgentProfileService {
  readonly _serviceBrand: undefined;

  register(): void;
  configure(options: ProfileServiceOptions): void;
  update(changed: ProfileUpdateData): void;
  applyBindingSnapshot(snapshot: ProfileBindingSnapshot): ProfileBindingSnapshot;
  bind(input: BindAgentInput): Promise<ProfileBindingSnapshot>;
  setModel(model: string): Promise<ProfileSetModelResult>;
  setThinking(level: string): void;
  republishStatus(snapshot?: ProfileBindingSnapshot): void;
  getModel(snapshot?: ProfileBindingSnapshot): string;
  useProfile(profile: ResolvedAgentProfile, context: SystemPromptContext): ProfileUpdateData;
  applyProfile(profile: ResolvedAgentProfile, options?: ApplyProfileOptions): Promise<ProfileUpdateData>;
  getAgentsMdWarning(snapshot?: ProfileBindingSnapshot): string | undefined;
  data(snapshot?: ProfileBindingSnapshot): ProfileData;
  getEffectiveThinkingLevel(snapshot?: ProfileBindingSnapshot): ThinkingEffort;
  resolveModelContext(snapshot?: ProfileBindingSnapshot): ProfileModelContext;
  resolveRequestParams(snapshot?: ProfileBindingSnapshot): ModelRequestParams;
  getModelCapabilities(snapshot?: ProfileBindingSnapshot): ModelCapability;
  getModelWireName(): string | undefined;
  getModelProviderType(alias?: string, snapshot?: ProfileBindingSnapshot): string | undefined;
  getMaxOutputSize(snapshot?: ProfileBindingSnapshot): number | undefined;
  hasModel(snapshot?: ProfileBindingSnapshot): boolean;
  isRunnable(snapshot?: ProfileBindingSnapshot): boolean;
  hasProvider(snapshot?: ProfileBindingSnapshot): boolean;
  getSystemPrompt(snapshot?: ProfileBindingSnapshot): string;
  getActiveToolNames(snapshot?: ProfileBindingSnapshot): readonly string[] | undefined;
  addActiveTool(name: string): void;
  removeActiveTool(name: string): void;
  refreshActiveTools(): Promise<void>;
  afterConfigDispatch(changed: Omit<ProfileUpdateData, 'activeToolNames'>, current?: ProfileBindingSnapshot): void;
  defaultProfile(): ProfileBindingSnapshot;
  prepareBindingSnapshot(snapshot: ProfileBindingSnapshot): ProfileBindingSnapshot;
  prepareUpdate(changed: ProfileUpdateData, current?: ProfileBindingSnapshot, activeTools?: readonly string[] | null): ProfileUpdatePlan;
  refreshBoundSubagentAllowlist(current?: ProfileBindingSnapshot): Promise<ProfileBindingSnapshot | undefined>;
  resolveBinding(input: BindAgentInput, current?: ProfileBindingSnapshot): Promise<ProfileBindingSnapshot>;
  resolveModel(model: string): ProfileSetModelResult;
  resolveThinkingLevel(level: string, current?: ProfileBindingSnapshot): string;

}

export const IAgentProfileService = createDecorator<IAgentProfileService>('agentProfileService');

export interface EffectiveProfileReader {
  data(): ProfileData;
  getEffectiveThinkingLevel(): ThinkingEffort;
  resolveModelContext(): ProfileModelContext;
  resolveRequestParams(): ModelRequestParams;
  getModelCapabilities(): ModelCapability;
  getModelProviderType(alias?: string, snapshot?: ProfileBindingSnapshot): string | undefined;
  getMaxOutputSize(): number | undefined;
  hasModel(): boolean;
  isRunnable(): boolean;
  hasProvider(): boolean;
  getModel(): string;
  getSystemPrompt(): string;
  getActiveToolNames(): readonly string[] | undefined;
  getAgentsMdWarning(): string | undefined;
  republishStatus(): void;
}
