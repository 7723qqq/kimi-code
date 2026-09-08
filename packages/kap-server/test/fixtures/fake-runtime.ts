import { posix as posixPath, win32 as win32Path } from 'node:path';

import { Emitter, type Event, type IDisposable } from '#/compat/core.js';



export type RuntimeStatus =
  | 'connecting'
  | 'ready'
  | 'degraded'
  | 'disconnected'
  | 'draining'
  | 'disposed';
export type RuntimeCapability = 'fs' | 'process' | 'watch' | 'terminal';

export interface RuntimeBinding {
  readonly workspaceId: string;
  readonly runtimeId: string;
}

export interface RuntimeIdentity extends RuntimeBinding {
  readonly generation: string;
}

export interface RuntimePath {
  readonly separator: '/' | '\\';
  readonly delimiter: ':' | ';';
  isAbsolute(path: string): boolean;
  join(...paths: readonly string[]): string;
  relative(from: string, to: string): string;
  resolve(...paths: readonly string[]): string;
  basename(path: string): string;
  dirname(path: string): string;
}

export interface RuntimeWorkspaceRoots {
  readonly workDir: string;
  readonly additionalDirs?: readonly string[];
}

export interface RuntimeWorkspaceMapper {
  mapRoots(roots: RuntimeWorkspaceRoots): RuntimeWorkspaceRoots;
}

export interface RuntimeEnvironment {
  readonly osKind: string;
  readonly osArch?: string;
  readonly osVersion?: string;
  readonly shellName?: string;
  readonly shellPath?: string;
  readonly pathClass: 'posix' | 'win32';
  readonly homeDir?: string;
  [key: string]: any;
}

export interface Runtime {
  readonly identity: RuntimeIdentity;
  readonly capabilities: ReadonlySet<RuntimeCapability>;
  readonly environment: RuntimeEnvironment;
  readonly path: RuntimePath;
  readonly workspace: RuntimeWorkspaceMapper;
  readonly fs?: unknown;
  readonly process?: unknown;
  readonly watch?: unknown;
  readonly terminal?: unknown;
  readonly status: RuntimeStatus;
  readonly onDidChangeStatus: Event<RuntimeStatus>;
  dispose(): void | Promise<void>;
}

const DRIVE_LETTER_ABSOLUTE = /^[A-Za-z]:[\\/]/;

function toForwardSlashes(value: string): string {
  return value.replaceAll('\\', '/');
}

export function createRuntimePath(pathClass: 'posix' | 'win32'): RuntimePath {
  if (pathClass === 'win32') {
    return {
      separator: win32Path.sep as '\\' | '/',
      delimiter: win32Path.delimiter as ';' | ':',
      isAbsolute: (p) => win32Path.isAbsolute(p),
      join: (...paths) => win32Path.join(...paths),
      relative: (from, to) => win32Path.relative(from, to),
      resolve: (...paths) => win32Path.resolve(...paths),
      basename: (p) => win32Path.basename(p),
      dirname: (p) => win32Path.dirname(p),
    };
  }

  return {
    separator: posixPath.sep as '/' | '\\',
    delimiter: posixPath.delimiter as ':' | ';',
    isAbsolute: (p) => posixPath.isAbsolute(p) || DRIVE_LETTER_ABSOLUTE.test(p),
    join: (...paths) => posixPath.join(...paths),
    relative: (from, to) => {
      if (DRIVE_LETTER_ABSOLUTE.test(from) && DRIVE_LETTER_ABSOLUTE.test(to)) {
        return toForwardSlashes(win32Path.relative(from, to));
      }
      return posixPath.relative(from, to);
    },
    resolve: (...paths) => {
      const anchor = paths.findIndex((segment) => DRIVE_LETTER_ABSOLUTE.test(segment));
      if (anchor < 0) return posixPath.resolve(...paths);
      return toForwardSlashes(win32Path.resolve(...paths.slice(anchor)));
    },
    basename: (p) => posixPath.basename(p),
    dirname: (p) => posixPath.dirname(p),
  };
}

export class FakeRuntime implements Runtime {
  readonly capabilities: ReadonlySet<RuntimeCapability>;
  readonly environment: RuntimeEnvironment;
  readonly path: RuntimePath;
  readonly workspace: RuntimeWorkspaceMapper;
  readonly fs = undefined;
  readonly process = undefined;
  readonly watch = undefined;
  readonly terminal = undefined;
  private currentStatus: RuntimeStatus;
  private readonly statusEmitter = new Emitter<RuntimeStatus>();
  readonly onDidChangeStatus: Event<RuntimeStatus>;
  disposed = false;

  constructor(
    readonly identity: RuntimeIdentity,
    options: {
      readonly status?: RuntimeStatus;
      readonly capabilities?: readonly RuntimeCapability[];
      readonly pathClass?: 'posix' | 'win32';
      readonly environment?: Partial<RuntimeEnvironment>;
      readonly mapWorkspaceRoots?: RuntimeWorkspaceMapper['mapRoots'];
    } = {},
  ) {
    this.currentStatus = options.status ?? 'ready';
    this.capabilities = new Set(options.capabilities ?? []);
    const path = createRuntimePath(options.pathClass ?? 'posix');
    this.environment = {
      osKind: 'fake',
      osArch: 'fake',
      osVersion: 'fake',
      shellName: 'sh' as const,
      shellPath: '/bin/sh',
      pathClass: options.pathClass ?? 'posix',
      homeDir: options.pathClass === 'win32' ? 'C:\\Users\\fake' : '/home/fake',
      ...options.environment,
    };
    this.path = path;
    this.workspace = {
      mapRoots: options.mapWorkspaceRoots
        ? options.mapWorkspaceRoots
        : (roots) => ({
            workDir: path.resolve(roots.workDir),
            additionalDirs: roots.additionalDirs?.map((root) => path.resolve(root)),
          }),
    };
    this.onDidChangeStatus = this.statusEmitter.event;
  }

  get status(): RuntimeStatus {
    return this.currentStatus;
  }

  setStatus(status: RuntimeStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.statusEmitter.fire(status);
  }

  dispose(): void {
    this.disposed = true;
    this.currentStatus = 'disposed';
    this.statusEmitter.fire('disposed');
    this.statusEmitter.dispose();
  }
}

export interface RuntimeLease {
  readonly runtime: Runtime;
  track<T extends { dispose(): void | Promise<void> }>(resource: T): T;
  dispose(): void;
}

export type { IDisposable };