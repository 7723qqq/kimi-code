import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';

export type WorkspaceSource = 'local';

export interface WorkspaceMeta {
  readonly id: string;
  readonly root: string;
  readonly name: string;
  readonly kind?: 'managed' | 'implicit';
  readonly createdAt: number;
  readonly lastOpenedAt: number;
}

export interface IProjectContext {
  readonly _serviceBrand: undefined;

  readonly workspaceId: string;
  readonly cwd: string;
  readonly source: WorkspaceSource;
  readonly remoteCwd?: string;
  readonly meta: WorkspaceMeta;
  readonly persistenceScope: string;
}

export const IProjectContext: ServiceIdentifier<IProjectContext> =
  createDecorator<IProjectContext>('workspaceContext');

export function workspaceContextSeed(ctx: IProjectContext): ScopeSeed {
  return [[IProjectContext as ServiceIdentifier<unknown>, ctx]];
}
