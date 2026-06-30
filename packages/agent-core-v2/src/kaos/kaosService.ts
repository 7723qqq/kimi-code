/**
 * `kaos` domain (L1) — `IKaos` implementation.
 *
 * Thin wrapper around a `@moonshot-ai/kaos` `Kaos` backend, exposing cwd, the
 * OS/shell probe, path primitives, and context derivation (`withCwd`/`withEnv`).
 * Not registered directly — built by `IKaosFactory` and seeded into a Session
 * scope by the composition root.
 */

import type { Kaos } from '@moonshot-ai/kaos';

import type { Environment, IKaos, PathClass } from './kaos';

export class KaosService implements IKaos {
  declare readonly _serviceBrand: undefined;

  constructor(readonly backend: Kaos) {}

  get name(): string {
    return this.backend.name;
  }

  get cwd(): string {
    return this.backend.getcwd();
  }

  get osEnv(): Environment {
    return this.backend.osEnv;
  }

  pathClass(): PathClass {
    return this.backend.pathClass();
  }

  normpath(path: string): string {
    return this.backend.normpath(path);
  }

  gethome(): string {
    return this.backend.gethome();
  }

  getcwd(): string {
    return this.backend.getcwd();
  }

  withCwd(cwd: string): IKaos {
    return new KaosService(this.backend.withCwd(cwd));
  }

  withEnv(env: Record<string, string>): IKaos {
    return new KaosService(this.backend.withEnv(env));
  }
}
