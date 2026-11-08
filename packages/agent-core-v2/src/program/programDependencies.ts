import type { LiveRef } from '#/_base/di/instantiation';
import type { ILogService } from '#/_base/log/log';
import type { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import type { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import type { IBuiltinAgentProfileLoader } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IConfigService } from '#/app/config/config';
import type { IGitService } from '#/app/git/git';
import type { IMcpConfigStore } from '#/app/mcpConfig/configStore';
import type { IPluginService } from '#/app/plugin/plugin';
import type { ISessionManager } from '#/app/sessionManager/sessionManager';
import type { IAppStateService } from '#/app/state/appState';
import type { IWorkspaceService } from '#/app/workspace/workspace';
import type { IWorkspacePersistence } from '#/app/workspace/workspacePersistence';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { SessionLifecycleService } from '#/workspace/sessionLifecycle/sessionLifecycleService';
import type { IExplicitAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/explicitAgentProfileLoader';
import type { IExtraAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/extraAgentProfileLoader';
import type { IPluginAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/pluginAgentProfileLoader';
import type { IUserAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
import type { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import type { IWorkspaceMcpService } from '#/workspace/workspaceMcp/workspaceMcp';
import type { IWorkspaceTrustStore } from '#/workspace/workspaceTrust/workspaceTrustStore';
import type { ProgramWorkdir } from './programWorkdirs';
import { McpOAuthService } from '#/mcpCore/oauth/service';
import { IBuiltinSkillSource } from '#/features/skill/catalog/builtinSkillSource';
import { IUserFileSkillSource } from '#/features/skill/catalog/userFileSkillSource';
import { ITelemetryService } from '#/app/telemetry/telemetry';

export interface ProgramSessionControllerInput {
  readonly context: IWorkspaceContext;
  readonly extraAgentProfiles: IExtraAgentProfileLoader;
  readonly explicitAgentProfiles: IExplicitAgentProfileLoader;
  readonly userAgentProfiles: IUserAgentProfileLoader;
  readonly pluginAgentProfiles: IPluginAgentProfileLoader;
  readonly mcp: IWorkspaceMcpService;
  readonly acquireWorkdir: (environmentId: string, cwd: string) => Promise<ProgramWorkdir>;
  readonly onDispose: () => void;
}

export interface ProgramDependencies {
  readonly appState: IAppStateService;
  readonly docs: IAtomicDocumentStore;
  readonly workspaces: IWorkspaceService;
  readonly workspaceStore: IWorkspacePersistence;
  readonly bootstrap: IBootstrapService;
  readonly config: IConfigService;
  readonly git: LiveRef<IGitService>;
  readonly identity: IAgentIdentity;
  readonly log: ILogService;
  readonly oauth: McpOAuthService;
  readonly configStore: IMcpConfigStore;
  readonly plugins: IPluginService;
  readonly sessionManager: LiveRef<ISessionManager>;
  readonly agentProfiles: IAgentProfileRegistry;
  readonly builtinAgentProfiles: IBuiltinAgentProfileLoader;
  readonly builtinSkills: IBuiltinSkillSource;
  readonly userSkills: IUserFileSkillSource;
  readonly telemetry: ITelemetryService;
  readonly trustStore: IWorkspaceTrustStore;
  createSessionController(input: ProgramSessionControllerInput): SessionLifecycleService;
}
