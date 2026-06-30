/**
 * `agentFs` domain (L1) — `IAgentFileSystem` implementation.
 *
 * Focused file-IO surface over the session execution environment (`IKaos.backend`).
 * Relative-path resolution (in the target path style) and symlink-safe glob are
 * handled by the kaos backend; this service exposes a kaos-free, filesystem-shaped
 * interface to business code and derives sub-views via `withCwd`. Bound at Session
 * scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IKaos, type StatResult } from '#/kaos';

import { type AgentFileStat, IAgentFileSystem } from './agentFs';

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

function statKind(s: StatResult): Pick<AgentFileStat, 'isFile' | 'isDirectory'> {
  const kind = s.stMode & S_IFMT;
  return { isFile: kind === S_IFREG, isDirectory: kind === S_IFDIR };
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

export class AgentFileSystem implements IAgentFileSystem {
  declare readonly _serviceBrand: undefined;

  constructor(@IKaos private readonly kaos: IKaos) {}

  get cwd(): string {
    return this.kaos.cwd;
  }

  readText(path: string): Promise<string> {
    return this.kaos.backend.readText(path);
  }

  writeText(path: string, data: string): Promise<void> {
    return this.kaos.backend.writeText(path, data).then(() => undefined);
  }

  readBytes(path: string, n?: number): Promise<Uint8Array> {
    return this.kaos.backend.readBytes(path, n);
  }

  writeBytes(path: string, data: Uint8Array): Promise<void> {
    return this.kaos.backend.writeBytes(path, Buffer.from(data)).then(() => undefined);
  }

  async stat(path: string): Promise<AgentFileStat> {
    const s = await this.kaos.backend.stat(path);
    return { ...statKind(s), size: s.stSize };
  }

  async readdir(path: string): Promise<readonly string[]> {
    const names: string[] = [];
    for await (const entry of this.kaos.backend.iterdir(path)) {
      names.push(basename(entry));
    }
    return names;
  }

  async glob(pattern: string): Promise<readonly string[]> {
    const out: string[] = [];
    for await (const match of this.kaos.backend.glob(this.kaos.cwd, pattern)) {
      out.push(match);
    }
    return out;
  }

  mkdir(path: string): Promise<void> {
    return this.kaos.backend.mkdir(path, { parents: true, existOk: true });
  }

  withCwd(cwd: string): IAgentFileSystem {
    return new AgentFileSystem(this.kaos.withCwd(cwd));
  }
}

registerScopedService(
  LifecycleScope.Session,
  IAgentFileSystem,
  AgentFileSystem,
  InstantiationType.Delayed,
  'agentFs',
);
