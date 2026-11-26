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
import type { IProjectService } from '#/app/project/project';
import type { IProjectPersistence } from '#/app/project/projectPersistence';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { SessionLifecycleService } from '#/project/sessionLifecycle/sessionLifecycleService';
import type { IExplicitAgentProfileLoader } from '#/project/projectAgentProfileLoader/explicitAgentProfileLoader';
import type { IExtraAgentProfileLoader } from '#/project/projectAgentProfileLoader/extraAgentProfileLoader';
import type { IPluginAgentProfileLoader } from '#/project/projectAgentProfileLoader/pluginAgentProfileLoader';
import type { IUserAgentProfileLoader } from '#/project/projectAgentProfileLoader/userAgentProfileLoader';
import type { IProjectContext } from '#/project/projectContext/projectContext';
import type { IProjectTrust } from '#/project/projectTrust/projectTrust';
import type { IProjectTrustStore } from '#/project/projectTrust/projectTrustStore';
import type { ProgramMcpLease } from './programMcp';
import type { ProgramWorkdir } from './programWorkdirs';
import { McpOAuthService } from '#/mcpCore/oauth/service';
import { IBuiltinSkillSource } from '#/features/skill/catalog/builtinSkillSource';
import { IUserFileSkillSource } from '#/features/skill/catalog/userFileSkillSource';
import { ITelemetryService } from '#/app/telemetry/telemetry';

export interface ProgramSessionControllerInput {
  readonly context: IProjectContext;
  readonly extraAgentProfiles: IExtraAgentProfileLoader;
  readonly explicitAgentProfiles: IExplicitAgentProfileLoader;
  readonly userAgentProfiles: IUserAgentProfileLoader;
  readonly pluginAgentProfiles: IPluginAgentProfileLoader;
  readonly acquireMcp: () => Promise<ProgramMcpLease>;
  readonly trust: IProjectTrust;
  readonly acquireWorkdir: (
    environmentId: string,
    cwd: string,
    followsPrimary?: boolean,
  ) => Promise<ProgramWorkdir>;
  readonly onDispose: () => void;
}

export interface ProgramDependencies {
  readonly appState: IAppStateService;
  readonly docs: IAtomicDocumentStore;
  readonly workspaces: IProjectService;
  readonly workspaceStore: IProjectPersistence;
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
  readonly trustStore: IProjectTrustStore;
  createSessionController(input: ProgramSessionControllerInput): SessionLifecycleService;
}
