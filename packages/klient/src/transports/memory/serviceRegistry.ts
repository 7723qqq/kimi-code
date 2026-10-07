/**
 * Service name → DI token registry for the in-process dispatcher. Only leaf
 * modules are imported (tokens + types) — never the engine root barrel, so
 * hosting klient in-process does not force the full registration side effects
 * beyond what the host already bootstrapped.
 */

import type { ServiceIdentifier } from '@moonshot-ai/agent-core-v2';
import { IAgentCommandService } from '@moonshot-ai/agent-core-v2/agent/command/agentCommand';
import { IAgentContextMemoryService } from '@moonshot-ai/agent-core-v2/agent/contextMemory/contextMemory';
import { IAgentFullCompactionService } from '@moonshot-ai/agent-core-v2/agent/fullCompaction/fullCompaction';
import { IAgentLoopService } from '@moonshot-ai/agent-core-v2/agent/loop/loop';
import { IAgentPromptChannel } from '@moonshot-ai/agent-core-v2/agent/loop/promptChannel';
import { IAgentMcpService } from '@moonshot-ai/agent-core-v2/agent/mcp/mcp';
import { IAgentPermissionModeService } from '@moonshot-ai/agent-core-v2/agent/permissionMode/permissionMode';
import { IAgentProfileService } from '@moonshot-ai/agent-core-v2/agent/profile/profile';
import { IAgentRuntimeBindingService } from '@moonshot-ai/agent-core-v2/agent/runtimeBinding/runtimeBinding';
import { IAgentShellCommandService } from '@moonshot-ai/agent-core-v2/agent/shellCommand/shellCommand';
import { IAgentTaskService } from '@moonshot-ai/agent-core-v2/agent/task/task';
import { IAuthSummaryService, IOAuthService } from '@moonshot-ai/agent-core-v2/app/auth/auth';
import { IBootstrapService } from '@moonshot-ai/agent-core-v2/app/bootstrap/bootstrap';
import { ICapabilityService } from '@moonshot-ai/agent-core-v2/app/capability/capability';
import { IConfigService } from '@moonshot-ai/agent-core-v2/app/config/config';
import { IEventService } from '@moonshot-ai/agent-core-v2/app/event/event';
import { IFileService } from '@moonshot-ai/agent-core-v2/app/file/fileService';
import { IFlagService } from '@moonshot-ai/agent-core-v2/app/flag/flag';
import { IHostFolderBrowser } from '@moonshot-ai/agent-core-v2/app/hostFolderBrowser/hostFolderBrowser';
import { IProviderDiscoveryService } from '@moonshot-ai/agent-core-v2/app/kosongConfig/discovery';
import { IModelsDevImportService } from '@moonshot-ai/agent-core-v2/app/kosongConfig/modelsDevImport';
import { IMcpManagementService } from '@moonshot-ai/agent-core-v2/app/mcpManagement/mcpManagement';
import { IPluginService } from '@moonshot-ai/agent-core-v2/app/plugin/plugin';
import { ISessionIndex } from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';
import { ISessionManager } from '@moonshot-ai/agent-core-v2/app/sessionManager/sessionManager';
import { IWorkspaceService } from '@moonshot-ai/agent-core-v2/app/workspace/workspace';
import { IAgentPlanService } from '@moonshot-ai/agent-core-v2/features/plan/plan';
import { ISessionSkillCatalog } from '@moonshot-ai/agent-core-v2/features/skill/session/skillCatalog';
import { IModelCatalog } from '@moonshot-ai/agent-core-v2/llm-adapter/model/catalog';
import { IModelService } from '@moonshot-ai/agent-core-v2/llm-adapter/model/model';
import { IProviderService } from '@moonshot-ai/agent-core-v2/llm-adapter/provider/provider';
import { ISessionActivityView } from '@moonshot-ai/agent-core-v2/session/sessionActivity/sessionActivity';
import { ISessionMetadata } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';
import { ISessionTitleService } from '@moonshot-ai/agent-core-v2/session/sessionTitle/sessionTitle';
import { ISessionTokenCountingService } from '@moonshot-ai/agent-core-v2/session/tokenCounting/sessionTokenCounting';
import { ISessionUsageService } from '@moonshot-ai/agent-core-v2/session/usage/sessionUsage';
import { IWorkspaceInstanceManager } from '@moonshot-ai/agent-core-v2/workspace/workspaceInstance/workspaceInstanceManager';

/** Wire service name (decorator id string) → token. */
export const serviceTokens: Readonly<Record<string, ServiceIdentifier<unknown>>> = {
  sessionIndex: ISessionIndex,
  workspaceService: IWorkspaceService,
  configService: IConfigService,
  modelService: IModelService,
  modelResolver: IModelCatalog,
  providerDiscovery: IProviderDiscoveryService,
  modelsDevImport: IModelsDevImportService,
  providerService: IProviderService,
  oauthService: IOAuthService,
  authSummaryService: IAuthSummaryService,
  flagService: IFlagService,
  pluginService: IPluginService,
  capabilityService: ICapabilityService,
  hostFolderBrowser: IHostFolderBrowser,
  bootstrapService: IBootstrapService,
  fileService: IFileService,
  workspaceInstanceManager: IWorkspaceInstanceManager,
  sessionManager: ISessionManager,
  sessionMetadata: ISessionMetadata,
  sessionSkillCatalog: ISessionSkillCatalog,
  sessionTitleService: ISessionTitleService,
  agentPromptService: IAgentPromptChannel,
  agentLoopService: IAgentLoopService,
  agentPermissionModeService: IAgentPermissionModeService,
  agentCommandService: IAgentCommandService,
  agentRuntimeBindingService: IAgentRuntimeBindingService,
  agentContextMemoryService: IAgentContextMemoryService,
  agentTokenCountingService: ISessionTokenCountingService,
  sessionActivityView: ISessionActivityView,
  agentShellCommandService: IAgentShellCommandService,
  agentProfileService: IAgentProfileService,
  agentUsageService: ISessionUsageService,
  agentPlanService: IAgentPlanService,
  agentTaskService: IAgentTaskService,
  agentMcpService: IAgentMcpService,
  agentFullCompactionService: IAgentFullCompactionService,
  mcpManagementService: IMcpManagementService,
};

export { IEventService };
