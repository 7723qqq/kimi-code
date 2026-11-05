import { Emitter } from '#/_base/event';
import { getShellPathBridge, type ShellPathBridge } from '#/_base/execEnv/shellPathBridge';
import { isWindowsAbsolutePath } from '#/_base/utils/paths';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostProcessService } from '#/os/interface/hostProcess';

import * as win32Path from 'node:path/win32';

import type { Environment, EnvironmentCapability, EnvironmentPath, EnvironmentStatus } from './environment';
import { ENVIRONMENT_PATHS } from './environmentDefaults';

let nextGeneration = 1;

export class LocalEnvironment implements Environment {
  readonly identity;
  readonly capabilities: ReadonlySet<EnvironmentCapability>;
  readonly host;
  readonly path: EnvironmentPath;
  readonly workspace: Environment['workspace'];
  readonly shellPathBridge: ShellPathBridge | undefined;
  readonly fs;
  readonly process;
  private currentStatus: EnvironmentStatus = 'ready';
  private readonly statusEmitter = new Emitter<EnvironmentStatus>();
  readonly onDidChangeStatus = this.statusEmitter.event;

  constructor(
    environment: IHostEnvironment,
    fs: IHostFileSystem | undefined,
    process: IHostProcessService | undefined,
  ) {
    this.identity = { environmentId: 'local', generation: `local-${nextGeneration++}` };
    const capabilities = new Set<EnvironmentCapability>();
    if (fs !== undefined) capabilities.add('fs');
    if (process !== undefined) capabilities.add('process');
    this.capabilities = capabilities;
    this.host = {
      osKind: environment.osKind,
      osArch: environment.osArch,
      osVersion: environment.osVersion,
      shellName: environment.shellName,
      shellPath: environment.shellPath,
      pathClass: environment.pathClass,
      homeDir: environment.homeDir,
    };
    const basePath = ENVIRONMENT_PATHS[environment.pathClass];
    const hostResolve = (...paths: readonly string[]): string => {
      const last = paths[paths.length - 1] ?? '';
      if (environment.pathClass === 'win32' || !paths.some(isWindowsAbsolutePath)) {
        return basePath.resolve(...paths);
      }
      if (paths.length === 1 && isWindowsAbsolutePath(last)) return last;
      return win32Path.resolve(...paths).split(String.fromCharCode(92)).join('/');
    };
    this.path = { ...basePath, resolve: hostResolve };
    this.workspace = {
      mapRoots: (roots) => ({
        workDir: hostResolve(roots.workDir),
        additionalDirs: roots.additionalDirs?.map((root) => hostResolve(root)),
      }),
    };
    this.shellPathBridge = environment.pathClass === 'win32' ? getShellPathBridge(environment) : undefined;
    this.fs = fs;
    this.process = process;
  }

  get status(): EnvironmentStatus {
    return this.currentStatus;
  }

  dispose(): void {
    this.currentStatus = 'disposed';
    this.statusEmitter.fire('disposed');
    this.statusEmitter.dispose();
  }
}
