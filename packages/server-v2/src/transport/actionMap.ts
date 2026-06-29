/**
 * `/api/v2` action map — the single allowlist of exposed Services.
 *
 * This is the server-side map from a public `resource:action` segment to the
 * internal `ServiceIdentifier` + method. Domain names (`ISessionMetadata`,
 * `IProfileService` …) never appear in the URL; this table is the only place
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
  IApprovalService,
  IAuthSummaryService,
  IBackgroundService,
  IBootstrapService,
  IConfigService,
  IContextMemory,
  IContextSizeService,
  IFlagService,
  IGoalService,
  IHostFolderBrowser,
  IInteractionService,
  IMcpService,
  IOAuthService,
  IPermissionModeService,
  IPermissionRulesService,
  IPlanService,
  IProfileService,
  IProviderService,
  IQuestionService,
  ISessionActivity,
  ISessionIndex,
  ISessionMetadata,
  ISessionService,
  ISwarmService,
  IToolRegistry,
  IToolStoreService,
  IUsageService,
  IWorkspaceContext,
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
    'session:archive': { service: ISessionService, method: 'archive' },

    'approvals:listPending': { service: IApprovalService, method: 'listPending', readonly: true },
    'approvals:request': { service: IApprovalService, method: 'enqueue' },
    'approvals:decide': { service: IApprovalService, method: 'decide' },

    'questions:listPending': { service: IQuestionService, method: 'listPending', readonly: true },
    'questions:ask': { service: IQuestionService, method: 'enqueue' },
    'questions:answer': { service: IQuestionService, method: 'answer' },

    'interactions:listPending': {
      service: IInteractionService,
      method: 'listPending',
      readonly: true,
    },
    'interactions:request': { service: IInteractionService, method: 'enqueue' },
    'interactions:respond': { service: IInteractionService, method: 'respond' },

    'workspace:resolve': { service: IWorkspaceContext, method: 'resolve', readonly: true },
    'workspace:isWithin': { service: IWorkspaceContext, method: 'isWithin', readonly: true },
    'workspace:setWorkDir': { service: IWorkspaceContext, method: 'setWorkDir' },
    'workspace:addAdditionalDir': { service: IWorkspaceContext, method: 'addAdditionalDir' },
    'workspace:removeAdditionalDir': { service: IWorkspaceContext, method: 'removeAdditionalDir' },
  },

  // -------------------------------------------------------------------------
  // Agent  (/api/v2/session/:session_id/agent/:agent_id/:resource:action)
  // -------------------------------------------------------------------------
  agent: {
    'goal:get': { service: IGoalService, method: 'getGoal', readonly: true },
    'goal:create': { service: IGoalService, method: 'createGoal' },
    'goal:pause': { service: IGoalService, method: 'pauseGoal' },
    'goal:resume': { service: IGoalService, method: 'resumeGoal' },
    'goal:cancel': { service: IGoalService, method: 'cancelGoal' },

    'plan:status': { service: IPlanService, method: 'status', readonly: true },
    'plan:enter': { service: IPlanService, method: 'enter' },
    'plan:exit': { service: IPlanService, method: 'exit' },
    'plan:cancel': { service: IPlanService, method: 'cancel' },
    'plan:clear': { service: IPlanService, method: 'clear' },

    'tasks:list': { service: IBackgroundService, method: 'list', readonly: true },
    'tasks:get': { service: IBackgroundService, method: 'getTask', readonly: true },
    'tasks:readOutput': { service: IBackgroundService, method: 'readOutput', readonly: true },
    'tasks:stop': { service: IBackgroundService, method: 'stop' },
    'tasks:detach': { service: IBackgroundService, method: 'detach' },

    'usage:status': { service: IUsageService, method: 'status', readonly: true },

    'context:status': { service: IContextSizeService, method: 'getStatus', readonly: true },

    'swarm:isActive': { service: ISwarmService, method: 'isActive', readonly: true },
    'swarm:enter': { service: ISwarmService, method: 'enter' },
    'swarm:exit': { service: ISwarmService, method: 'exit' },

    'permission:getMode': { service: IPermissionModeService, method: 'mode', readonly: true },
    'permission:setMode': { service: IPermissionModeService, method: 'setMode' },

    'permissionRules:list': { service: IPermissionRulesService, method: 'rules', readonly: true },
    'permissionRules:addRules': { service: IPermissionRulesService, method: 'addRules' },

    'profile:get': { service: IProfileService, method: 'data', readonly: true },
    'profile:getModel': { service: IProfileService, method: 'getModel', readonly: true },
    'profile:getSystemPrompt': {
      service: IProfileService,
      method: 'getSystemPrompt',
      readonly: true,
    },
    'profile:getActiveToolNames': {
      service: IProfileService,
      method: 'getActiveToolNames',
      readonly: true,
    },
    'profile:setModel': { service: IProfileService, method: 'setModel' },
    'profile:setThinking': { service: IProfileService, method: 'setThinking' },

    'messages:list': { service: IContextMemory, method: 'get', readonly: true },
    'messages:splice': { service: IContextMemory, method: 'splice' },

    'toolStore:get': { service: IToolStoreService, method: 'get', readonly: true },
    'toolStore:data': { service: IToolStoreService, method: 'data', readonly: true },
    'toolStore:set': { service: IToolStoreService, method: 'set' },

    'mcp:list': { service: IMcpService, method: 'list', readonly: true },
    'mcp:reconnect': { service: IMcpService, method: 'reconnect' },

    'tools:list': { service: IToolRegistry, method: 'list', readonly: true },
  },
};

/** Look up an action target within a scope. */
export function resolveAction(
  scopeKind: ScopeKind,
  sa: { resource: string; action: string },
): ActionTarget | undefined {
  return actionMap[scopeKind][`${sa.resource}:${sa.action}`];
}
