import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { SessionSummary } from '#/app/sessionIndex/sessionIndex';

export type { SessionSummary };

export const RECENT_SESSIONS_LIMIT = 20;

export interface IProjectSessions {
  readonly _serviceBrand: undefined;

  listRecent(workspaceId: string): Promise<readonly SessionSummary[]>;
  count(workspaceId: string): Promise<number>;
}

export const IProjectSessions: ServiceIdentifier<IProjectSessions> =
  createDecorator<IProjectSessions>('workspaceSessions');
