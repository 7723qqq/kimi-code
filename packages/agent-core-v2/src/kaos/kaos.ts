/**
 * `kaos` domain (L1) — execution-environment contracts.
 *
 * Defines `IKaos`, the Agent's execution environment (cwd, env layers, the
 * OS/shell probe, and the backend handle the fs/process domains delegate to),
 * plus `IKaosFactory`, the Core factory that builds an `IKaos` for a session
 * (local today; ssh/container behind the same factory later).
 *
 * Temporary: this domain wraps the `@moonshot-ai/kaos` package and re-exports
 * a few of its data types so business code imports them from `#/kaos` instead
 * of the package. `IKaos` is seeded into each Session scope by the composition
 * root; `IKaosFactory` is bound at Core scope.
 */

import type { Environment, Kaos } from '@moonshot-ai/kaos';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export type { Environment, KaosProcess, StatResult } from '@moonshot-ai/kaos';
export { detectEnvironmentFromNode } from '@moonshot-ai/kaos';

export type PathClass = 'posix' | 'win32';

export interface IKaos {
  readonly _serviceBrand: undefined;

  /** Human-readable backend name (e.g. `"local"`, `"ssh:host"`). */
  readonly name: string;
  /** Current working directory of this execution environment. */
  readonly cwd: string;
  /** OS / shell probe of the execution environment. */
  readonly osEnv: Environment;
  /**
   * The backend fs/process domains delegate to. Temporary — owned by this
   * environment; business code should reach for `IAgentFileSystem` /
   * `IProcessRunner` instead of touching this directly.
   */
  readonly backend: Kaos;

  pathClass(): PathClass;
  normpath(path: string): string;
  gethome(): string;
  getcwd(): string;

  /** Derive a new environment rooted at `cwd` (shares backend + osEnv). */
  withCwd(cwd: string): IKaos;
  /** Derive a new environment that overlays `env` onto spawned processes. */
  withEnv(env: Record<string, string>): IKaos;
}

export const IKaos: ServiceIdentifier<IKaos> = createDecorator<IKaos>('kaos');

export interface IKaosFactory {
  readonly _serviceBrand: undefined;

  /** Build a local execution environment rooted at `cwd`. */
  createLocal(cwd: string): Promise<IKaos>;
}

export const IKaosFactory: ServiceIdentifier<IKaosFactory> =
  createDecorator<IKaosFactory>('kaosFactory');
