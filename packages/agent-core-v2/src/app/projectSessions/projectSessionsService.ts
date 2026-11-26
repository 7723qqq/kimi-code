import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { IProjectAliases } from '#/app/projectAliases/projectAliases';

import { IProjectSessions, RECENT_SESSIONS_LIMIT } from './projectSessions';

export class WorkspaceSessionsService implements IProjectSessions {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IProjectAliases private readonly aliases: IProjectAliases,
    @ISessionIndex private readonly index: ISessionIndex,
  ) {}

  async listRecent(workspaceId: string): Promise<readonly SessionSummary[]> {
    const workspaceIds = await this.aliases.resolveAliasIds(workspaceId);
    const page = await this.index.listRecent({ workspaceIds, limit: RECENT_SESSIONS_LIMIT });
    return page.items;
  }

  async count(workspaceId: string): Promise<number> {
    const workspaceIds = await this.aliases.resolveAliasIds(workspaceId);
    return this.index.count({ workspaceIds, includeArchived: true });
  }
}

registerScopedService(
  LifecycleScope.App,
  IProjectSessions,
  WorkspaceSessionsService,
  ScopeActivation.OnScopeCreated,
  'workspaceSessions',
);
