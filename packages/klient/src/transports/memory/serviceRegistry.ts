/**
 * Service name → DI token registry for the in-process dispatcher. Only leaf
 * modules are imported (tokens + types) — never the engine root barrel, so
 * hosting klient in-process does not force the full registration side effects
 * beyond what the host already bootstrapped.
 */

import type { ServiceIdentifier } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';
import { IAgentActivityView } from '@moonshot-ai/agent-core-v2/agent/activityView/activityView';
import { IAgentCommandService } from '@moonshot-ai/agent-core-v2/agent/command/agentCommand';
import { IAgentContextMemoryService } from '@moonshot-ai/agent-core-v2/agent/contextMemory/contextMemory';
import { IAgentFullCompactionService } from '@moonshot-ai/agent-core-v2/agent/fullCompaction/fullCompaction';
import { IAgentLoopService } from '@moonshot-ai/agent-core-v2/agent/loop/loop';
import { IAgentMcpService } from '@moonshot-ai/agent-core-v2/agent/mcp/mcp';
import { IAgentPermissionModeService } from '@moonshot-ai/agent-core-v2/agent/permissionMode/permissionMode';
import { IAgentProfileService } from '@moonshot-ai/agent-core-v2/agent/profile/profile';
import { IAgentPromptService } from '@moonshot-ai/agent-core-v2/agent/prompt/prompt';
import { IAgentShellCommandService } from '@moonshot-ai/agent-core-v2/agent/shellCommand/shellCommand';
import { IAgentSkillService } from '@moonshot-ai/agent-core-v2/agent/skill/skill';
import { IAgentTaskService } from '@moonshot-ai/agent-core-v2/agent/task/task';
import { IAgentTokenCountingService } from '@moonshot-ai/agent-core-v2/agent/tokenCounting/tokenCounting';
import { IAgentUsageService } from '@moonshot-ai/agent-core-v2/agent/usage/usage';
import { IAuthSummaryService, IOAuthService } from '@moonshot-ai/agent-core-v2/app/auth/auth';
import { IBootstrapService } from '@moonshot-ai/agent-core-v2/app/bootstrap/bootstrap';
import { ICapabilityService } from '@moonshot-ai/agent-core-v2/app/capability/capability';
import { IConfigService } from '@moonshot-ai/agent-core-v2/app/config/config';
import { IEventService } from '@moonshot-ai/agent-core-v2/app/event/event';
import { IFlagService } from '@moonshot-ai/agent-core-v2/app/flag/flag';
import { IHostFolderBrowser } from '@moonshot-ai/agent-core-v2/app/hostFolderBrowser/hostFolderBrowser';
import { IProviderDiscoveryService } from '@moonshot-ai/agent-core-v2/app/kosongConfig/discovery';
import { IPluginService } from '@moonshot-ai/agent-core-v2/app/plugin/plugin';
import { ISessionIndex } from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';
import { IWorkspaceService } from '@moonshot-ai/agent-core-v2/app/workspace/workspace';
import { IWorkspaceLifecycleService } from '@moonshot-ai/agent-core-v2/app/workspaceLifecycle/workspaceLifecycle';
import { IAgentPlanService } from '@moonshot-ai/agent-core-v2/features/plan/plan';
import { IModelCatalog } from '@moonshot-ai/agent-core-v2/kosong/model/catalog';
import { IModelService } from '@moonshot-ai/agent-core-v2/kosong/model/model';
import { IProviderService } from '@moonshot-ai/agent-core-v2/kosong/provider/provider';
import { ISessionApprovalService } from '@moonshot-ai/agent-core-v2/session/approval/approval';
import { ISessionInteractionService } from '@moonshot-ai/agent-core-v2/session/interaction/interaction';
import { ISessionQuestionService } from '@moonshot-ai/agent-core-v2/session/question/question';
import { ISessionMetadata } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';
import { ISessionSkillCatalog } from '@moonshot-ai/agent-core-v2/session/sessionSkillCatalog/skillCatalog';
import { ISessionTitleService } from '@moonshot-ai/agent-core-v2/session/sessionTitle/sessionTitle';
import { ISessionLifecycleService } from '@moonshot-ai/agent-core-v2/workspace/sessionLifecycle/sessionLifecycle';

/** Wire service name (decorator id string) → token. */
export const serviceTokens: Readonly<Record<string, ServiceIdentifier<unknown>>> = {
  sessionIndex: ISessionIndex,
  workspaceService: IWorkspaceService,
  configService: IConfigService,
  modelService: IModelService,
  modelResolver: IModelCatalog,
  providerDiscovery: IProviderDiscoveryService,
  providerService: IProviderService,
  oauthService: IOAuthService,
  authSummaryService: IAuthSummaryService,
  flagService: IFlagService,
  pluginService: IPluginService,
  capabilityService: ICapabilityService,
  hostFolderBrowser: IHostFolderBrowser,
  bootstrapService: IBootstrapService,
  workspaceLifecycleService: IWorkspaceLifecycleService,
  sessionLifecycleService: ISessionLifecycleService,
  sessionMetadata: ISessionMetadata,
  sessionInteractionService: ISessionInteractionService,
  sessionApprovalService: ISessionApprovalService,
  sessionQuestionService: ISessionQuestionService,
  sessionSkillCatalog: ISessionSkillCatalog,
  sessionTitleService: ISessionTitleService,
  agentPromptService: IAgentPromptService,
  agentSkillService: IAgentSkillService,
  agentLoopService: IAgentLoopService,
  agentPermissionModeService: IAgentPermissionModeService,
  agentCommandService: IAgentCommandService,
  agentContextMemoryService: IAgentContextMemoryService,
  agentTokenCountingService: IAgentTokenCountingService,
  agentActivityView: IAgentActivityView,
  agentShellCommandService: IAgentShellCommandService,
  agentProfileService: IAgentProfileService,
  agentUsageService: IAgentUsageService,
  agentPlanService: IAgentPlanService,
  agentTaskService: IAgentTaskService,
  agentMcpService: IAgentMcpService,
  agentFullCompactionService: IAgentFullCompactionService,
};

export { IEventService };
