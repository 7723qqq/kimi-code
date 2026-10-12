import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { ISessionWorkspaceInfo } from '#/session/workspaceInfo/workspaceInfo';

export interface WorkspaceAddDirInput {
  readonly path: string;
  readonly persist?: boolean;
}

export interface WorkspaceAdditionalDirsResult {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly additionalDirs: readonly string[];
  readonly persisted: boolean;
}

export interface IWorkspaceDirs {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly additionalDirs: readonly string[];
  readonly onDidChange: Event<void>;
  addDir(input: WorkspaceAddDirInput): Promise<WorkspaceAdditionalDirsResult>;
  /**
   * Widen the workspace with a session's extra roots. Returns a disposable that
   * releases THIS session's hold; the directories stay while any other live
   * session still names them.
   */
  mergeAdditionalDirs(baseDir: string, dirs: readonly string[]): Promise<IDisposable>;
  sessionInfo(): ISessionWorkspaceInfo;
}

export const IWorkspaceDirs: ServiceIdentifier<IWorkspaceDirs> =
  createDecorator<IWorkspaceDirs>('workspaceDirs');
