/**
 * `/api/v2` action map — the single allowlist of exposed Services.
 *
 * This is the server-side map from a public `resource:action` segment to the
 * internal `ServiceIdentifier` + method. Domain names (`ISessionMetadata`,
 * `IAgentProfileService` …) never appear in the URL; this table is the only place
 * that binds a public action to an internal Service.
 *
 * It also doubles as the **cheatsheet** of every directly-exposed endpoint.
 * `readonly: true` means the action is exposed on `GET` as well as `POST`.
 *
 * URL shapes:
 *   /api/v2/:sa                                       Core
 *   /api/v2/session/:session_id/:sa                   Session
 *   /api/v2/session/:session_id/agent/:agent_id/:sa   Agent
 * where `:sa` = `<resource>:<action>`.
 *
 * Only Services that are data/command (JSON in/out, `KimiError`) are listed
 * here. Handle/stream/byte-store/sink Services are intentionally omitted —
 * they need a wrapper (see `edge-exposure.md` §4) and are not part of this
 * direct-exposure surface.
 */

import {
  IAgentRPCService,
  ISessionApprovalService,
  IAuthSummaryService,
  IAgentTaskService,
  IBootstrapService,
  IConfigService,
  IAgentContextMemoryService,
  IAgentContextSizeService,
  IFlagService,
  ISessionFsService,
  IAgentGoalService,
  IHostFolderBrowser,
  ISessionInteractionService,
  IAgentMcpService,
  IOAuthService,
  IAgentPermissionModeService,
  IAgentPermissionRulesService,
  IAgentPlanService,
  IAgentProfileService,
  IPluginService,
  IProviderService,
  ISessionQuestionService,
  ISessionActivity,
  ISessionIndex,
  ISessionLifecycleService,
  ISessionMetadata,
  IAgentSwarmService,
  IAgentToolRegistryService,
  IAgentToolState,
  IAgentUsageService,
  ISessionWorkspaceContext,
  IWorkspaceRegistry,
} from '@moonshot-ai/agent-core-v2';

import type { ActionTarget, ScopeKind } from './channel';

export const actionMap: Record<ScopeKind, Record<string, ActionTarget>> = {
  // -------------------------------------------------------------------------
  // Core  (/api/v2/:resource:action)
  // -------------------------------------------------------------------------
  core: {
    'sessions:list': { service: ISessionIndex, method: 'list', readonly: true },
    'sessions:get': { service: ISessionIndex, method: 'get', readonly: true },
    'sessions:countActive': { service: ISessionIndex, method: 'countActive', readonly: true },

    'workspaces:list': { service: IWorkspaceRegistry, method: 'list', readonly: true },
    'workspaces:get': { service: IWorkspaceRegistry, method: 'get', readonly: true },
    'workspaces:createOrTouch': { service: IWorkspaceRegistry, method: 'createOrTouch' },
    'workspaces:update': { service: IWorkspaceRegistry, method: 'update' },
    'workspaces:delete': { service: IWorkspaceRegistry, method: 'delete' },

    'config:get': { service: IConfigService, method: 'get', readonly: true },
    'config:getAll': { service: IConfigService, method: 'getAll', readonly: true },
    'config:inspect': { service: IConfigService, method: 'inspect', readonly: true },
    'config:diagnostics': { service: IConfigService, method: 'diagnostics', readonly: true },
    'config:set': { service: IConfigService, method: 'set' },
    'config:replace': { service: IConfigService, method: 'replace' },
    'config:reload': { service: IConfigService, method: 'reload' },

    'providers:list': { service: IProviderService, method: 'list', readonly: true },
    'providers:get': { service: IProviderService, method: 'get', readonly: true },
    'providers:set': { service: IProviderService, method: 'set' },
    'providers:delete': { service: IProviderService, method: 'delete' },

    'oauth:startLogin': { service: IOAuthService, method: 'startLogin' },
    'oauth:getFlow': { service: IOAuthService, method: 'getFlow', readonly: true },
    'oauth:cancelLogin': { service: IOAuthService, method: 'cancelLogin' },
    'oauth:logout': { service: IOAuthService, method: 'logout' },
    'oauth:status': { service: IOAuthService, method: 'status', readonly: true },

    'auth:summarize': { service: IAuthSummaryService, method: 'summarize', readonly: true },
    'auth:ensureReady': { service: IAuthSummaryService, method: 'ensureReady' },

    'flags:snapshot': { service: IFlagService, method: 'snapshot', readonly: true },
    'flags:enabled': { service: IFlagService, method: 'enabled', readonly: true },
    'flags:enabledIds': { service: IFlagService, method: 'enabledIds', readonly: true },
    'flags:explain': { service: IFlagService, method: 'explain', readonly: true },
    'flags:explainAll': { service: IFlagService, method: 'explainAll', readonly: true },

    'plugins:list': { service: IPluginService, method: 'listPlugins', readonly: true },
    'plugins:install': { service: IPluginService, method: 'installPlugin' },
    'plugins:setEnabled': { service: IPluginService, method: 'setPluginEnabled' },
    'plugins:setMcpServerEnabled': {
      service: IPluginService,
      method: 'setPluginMcpServerEnabled',
    },
    'plugins:remove': { service: IPluginService, method: 'removePlugin' },
    'plugins:reload': { service: IPluginService, method: 'reloadPlugins' },
    'plugins:getInfo': { service: IPluginService, method: 'getPluginInfo', readonly: true },
    'plugins:listCommands': { service: IPluginService, method: 'listPluginCommands', readonly: true },
    'plugins:checkUpdates': { service: IPluginService, method: 'checkUpdates', readonly: true },

    'fs:browse': { service: IHostFolderBrowser, method: 'browse', readonly: true },
    'fs:home': { service: IHostFolderBrowser, method: 'home', readonly: true },

    'meta:getEnv': { service: IBootstrapService, method: 'getEnv', readonly: true },
    'meta:detect': { service: IBootstrapService, method: 'detect', readonly: true },
  },

  // -------------------------------------------------------------------------
  // Session  (/api/v2/session/:session_id/:resource:action)
  // -------------------------------------------------------------------------
  session: {
    'session:read': { service: ISessionMetadata, method: 'read', readonly: true },
    'session:update': { service: ISessionMetadata, method: 'update' },
    'session:setTitle': { service: ISessionMetadata, method: 'setTitle' },
    'session:setArchived': { service: ISessionMetadata, method: 'setArchived' },
    'session:status': { service: ISessionActivity, method: 'status', readonly: true },
    'session:isIdle': { service: ISessionActivity, method: 'isIdle', readonly: true },
    'session:archive': { service: ISessionLifecycleService, method: 'archive' },

    'approvals:listPending': { service: ISessionApprovalService, method: 'listPending', readonly: true },
    'approvals:request': { service: ISessionApprovalService, method: 'enqueue' },
    'approvals:decide': { service: ISessionApprovalService, method: 'decide' },

    'questions:listPending': { service: ISessionQuestionService, method: 'listPending', readonly: true },
    'questions:ask': { service: ISessionQuestionService, method: 'enqueue' },
    'questions:answer': { service: ISessionQuestionService, method: 'answer' },

    'interactions:listPending': {
      service: ISessionInteractionService,
      method: 'listPending',
      readonly: true,
    },
    'interactions:request': { service: ISessionInteractionService, method: 'enqueue' },
    'interactions:respond': { service: ISessionInteractionService, method: 'respond' },

    'workspace:resolve': { service: ISessionWorkspaceContext, method: 'resolve', readonly: true },
    'workspace:isWithin': { service: ISessionWorkspaceContext, method: 'isWithin', readonly: true },
    'workspace:setWorkDir': { service: ISessionWorkspaceContext, method: 'setWorkDir' },
    'workspace:addAdditionalDir': { service: ISessionWorkspaceContext, method: 'addAdditionalDir' },
    'workspace:removeAdditionalDir': { service: ISessionWorkspaceContext, method: 'removeAdditionalDir' },

    'fs:search': { service: ISessionFsService, method: 'search', readonly: true },
    'fs:grep': { service: ISessionFsService, method: 'grep', readonly: true },
    'fs:gitStatus': { service: ISessionFsService, method: 'gitStatus', readonly: true },
    'fs:diff': { service: ISessionFsService, method: 'diff', readonly: true },
  },

  // -------------------------------------------------------------------------
  // Agent  (/api/v2/session/:session_id/agent/:agent_id/:resource:action)
  // -------------------------------------------------------------------------
  agent: {
    'goal:get': { service: IAgentGoalService, method: 'getGoal', readonly: true },
    'goal:create': { service: IAgentGoalService, method: 'createGoal' },
    'goal:pause': { service: IAgentGoalService, method: 'pauseGoal' },
    'goal:resume': { service: IAgentGoalService, method: 'resumeGoal' },
    'goal:cancel': { service: IAgentGoalService, method: 'cancelGoal' },

    'plan:status': { service: IAgentPlanService, method: 'status', readonly: true },
    'plan:enter': { service: IAgentPlanService, method: 'enter' },
    'plan:exit': { service: IAgentPlanService, method: 'exit' },
    'plan:cancel': { service: IAgentPlanService, method: 'cancel' },
    'plan:clear': { service: IAgentPlanService, method: 'clear' },

    'tasks:list': { service: IAgentTaskService, method: 'list', readonly: true },
    'tasks:get': { service: IAgentTaskService, method: 'getTask', readonly: true },
    'tasks:readOutput': { service: IAgentTaskService, method: 'readOutput', readonly: true },
    'tasks:stop': { service: IAgentTaskService, method: 'stop' },
    'tasks:detach': { service: IAgentTaskService, method: 'detach' },

    'usage:status': { service: IAgentUsageService, method: 'status', readonly: true },

    'context:status': { service: IAgentContextSizeService, method: 'getStatus', readonly: true },

    'swarm:isActive': { service: IAgentSwarmService, method: 'isActive', readonly: true },
    'swarm:enter': { service: IAgentSwarmService, method: 'enter' },
    'swarm:exit': { service: IAgentSwarmService, method: 'exit' },

    'permission:getMode': { service: IAgentPermissionModeService, method: 'mode', readonly: true },
    'permission:setMode': { service: IAgentPermissionModeService, method: 'setMode' },

    'permissionRules:list': { service: IAgentPermissionRulesService, method: 'rules', readonly: true },
    'permissionRules:addRules': { service: IAgentPermissionRulesService, method: 'addRules' },

    'profile:get': { service: IAgentProfileService, method: 'data', readonly: true },
    'profile:getModel': { service: IAgentProfileService, method: 'getModel', readonly: true },
    'profile:getSystemPrompt': {
      service: IAgentProfileService,
      method: 'getSystemPrompt',
      readonly: true,
    },
    'profile:getActiveToolNames': {
      service: IAgentProfileService,
      method: 'getActiveToolNames',
      readonly: true,
    },
    'profile:setModel': { service: IAgentProfileService, method: 'setModel' },
    'profile:setThinking': { service: IAgentProfileService, method: 'setThinking' },

    'messages:list': { service: IAgentContextMemoryService, method: 'get', readonly: true },
    'messages:splice': { service: IAgentContextMemoryService, method: 'splice' },

    'toolStore:get': { service: IAgentToolState, method: 'get', readonly: true },
    'toolStore:data': { service: IAgentToolState, method: 'data', readonly: true },
    'toolStore:set': { service: IAgentToolState, method: 'set' },

    'mcp:list': { service: IAgentMcpService, method: 'list', readonly: true },
    'mcp:reconnect': { service: IAgentMcpService, method: 'reconnect' },

    'tools:list': { service: IAgentToolRegistryService, method: 'list', readonly: true },

    // `prompts:*` is the one facade-backed group in this map: `IPromptService`
    // returns a live `Turn` handle, so it is reached through the wire-shaped
    // `IAgentRPCService` facade which surfaces the serializable `turn_id`
    // instead (see edge-exposure.md §4).
    'prompts:submit': { service: IAgentRPCService, method: 'prompt' },
    'shell:run': { service: IAgentRPCService, method: 'runShellCommand' },
    'shell:cancel': { service: IAgentRPCService, method: 'cancelShellCommand' },
    'plugins:activateCommand': { service: IAgentRPCService, method: 'activatePluginCommand' },
    'prompts:steer': { service: IAgentRPCService, method: 'steer' },
    'prompts:undo': { service: IAgentRPCService, method: 'undoHistory' },
    'prompts:clear': { service: IAgentRPCService, method: 'clearContext' },
    'prompts:cancel': { service: IAgentRPCService, method: 'cancel' },
  },
};

/** Look up an action target within a scope. */
export function resolveAction(
  scopeKind: ScopeKind,
  sa: { resource: string; action: string },
): ActionTarget | undefined {
  return actionMap[scopeKind][`${sa.resource}:${sa.action}`];
}
