import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import type { ISessionProjectInfo } from '#/session/projectInfo/projectInfo';

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

export interface IProjectDirs {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  readonly primary: string;
  readonly additionalDirs: readonly string[];
  readonly sharedAdditionalDirs: readonly string[];
  readonly ISessionProjectInfo: Readonly<Record<string, string>>;
  readonly onDidChange: Event<void>;
  addDir(input: WorkspaceAddDirInput): Promise<WorkspaceAdditionalDirsResult>;
  mergeAdditionalDirs(baseDir: string, dirs: readonly string[]): Promise<IDisposable>;
  reload(): Promise<void>;
  sessionInfo(): ISessionProjectInfo;
}

export const IProjectDirs: ServiceIdentifier<IProjectDirs> =
  createDecorator<IProjectDirs>('workspaceDirs');
