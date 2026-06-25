/**
 * `workspace` domain (cross-cutting) — `IWorkspaceService` implementation.
 *
 * Turns the raw `Kaos` environments and additional roots owned by
 * `ISessionKaosService` into workspace-relative path operations. Bound at
 * Session scope — one instance per session.
 */

import type { Kaos } from '@moonshot-ai/kaos';

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import {
  type PathAccessOperation,
  type PathClass,
  assertPathAllowed,
  canonicalizePath,
  isWithinWorkspace,
} from '#/_base/tools/policies/path-access';
import type { WorkspaceConfig } from '#/_base/tools/support/workspace';
import { ISessionKaosService } from '#/kaos/kaos';
import { ILogService } from '#/log/log';

import { IWorkspaceService } from './workspace';

export class WorkspaceService extends Disposable implements IWorkspaceService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionKaosService private readonly sessionKaos: ISessionKaosService,
    @ILogService private readonly _log: ILogService,
  ) {
    super();
  }

  private get kaos(): Kaos {
    return this.sessionKaos.toolKaos;
  }

  private get pathClass(): PathClass {
    return this.kaos.pathClass();
  }

  get workDir(): string {
    return this.kaos.getcwd();
  }

  get additionalDirs(): readonly string[] {
    return this.sessionKaos.additionalDirs;
  }

  resolve(rel: string): string {
    return canonicalizePath(rel, this.workDir, this.pathClass);
  }

  isWithin(path: string): boolean {
    return isWithinWorkspace(this.resolve(path), this.toConfig(), this.pathClass);
  }

  assertAllowed(path: string, op: PathAccessOperation): string {
    return assertPathAllowed(path, this.workDir, this.toConfig(), {
      mode: op,
      pathClass: this.pathClass,
    });
  }

  toConfig(): WorkspaceConfig {
    return { workspaceDir: this.workDir, additionalDirs: this.additionalDirs };
  }

  addAdditionalDir(dir: string): void {
    this.sessionKaos.addAdditionalDir(dir);
  }

  removeAdditionalDir(dir: string): void {
    this.sessionKaos.removeAdditionalDir(dir);
  }
}

registerScopedService(
  LifecycleScope.Session,
  IWorkspaceService,
  WorkspaceService,
  InstantiationType.Delayed,
  'workspace',
);
