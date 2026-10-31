import { createDecorator } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { LifecycleScope } from '#/app/scopes';
import { IHostProcessService } from '#/os/interface/hostProcess';

import { memoryDir } from './memoryPaths';

export const MEMORY_AUTHOR_NAME = 'kimi-code memory';
export const MEMORY_AUTHOR_EMAIL = 'memory@local';

export interface MemoryCommit {
  readonly sha: string;
  readonly date: string;
  readonly message: string;
}

export interface IMemoryRepo {
  readonly _serviceBrand: undefined;

  commit(message: string): Promise<boolean>;

  logCommits(limit: number): Promise<readonly MemoryCommit[]>;

  revert(sha: string): Promise<boolean>;
}

export const IMemoryRepo = createDecorator<IMemoryRepo>('memoryRepo');

export class MemoryRepo extends Disposable implements IMemoryRepo {
  declare readonly _serviceBrand: undefined;

  private queue: Promise<unknown> = Promise.resolve();
  private initialized = false;

  constructor(
    @IHostProcessService private readonly process: IHostProcessService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
  }

  private get dir(): string {
    return memoryDir(this.bootstrap.homeDir);
  }

  private async run(args: readonly string[]): Promise<{ ok: boolean; stdout: string }> {
    try {
      const child = await this.process.spawn('git', args, { cwd: this.dir });
      try {
        child.stdin.end();
      } catch {}
      const chunks: Buffer[] = [];
      for await (const chunk of child.stdout) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      }
      const code = await child.wait();
      return { ok: code === 0, stdout: Buffer.concat(chunks).toString('utf-8') };
    } catch (error) {
      this.log.warn('memory repo command failed', { error });
      return { ok: false, stdout: '' };
    }
  }

  private async ensureRepo(): Promise<boolean> {
    if (this.initialized) return true;
    const { mkdir } = await import('node:fs/promises');
    try {
      await mkdir(this.dir, { recursive: true });
    } catch (error) {
      this.log.warn('memory repo directory could not be created', { dir: this.dir, error });
      return false;
    }
    const init = await this.run(['init']);
    if (!init.ok) {
      this.log.warn('memory repo could not be initialised', { dir: this.dir });
      return false;
    }
    this.initialized = true;
    return true;
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async commit(message: string): Promise<boolean> {
    return this.serialize(async () => {
      if (!(await this.ensureRepo())) return false;
      const add = await this.run(['add', '-A']);
      if (!add.ok) {
        this.log.warn('memory repo staging failed', { dir: this.dir });
        return false;
      }
      const commit = await this.run([
        '-c',
        `user.name=${MEMORY_AUTHOR_NAME}`,
        '-c',
        `user.email=${MEMORY_AUTHOR_EMAIL}`,
        'commit',
        '-m',
        message,
      ]);
      if (!commit.ok) {
        this.log.warn('memory repo commit failed', { dir: this.dir, message });
        return false;
      }
      return true;
    });
  }

  async logCommits(limit: number): Promise<readonly MemoryCommit[]> {
    const result = await this.run([
      'log',
      `-${limit}`,
      '--date=short',
      '--format=%H%x09%ad%x09%s',
    ]);
    if (!result.ok) return [];
    const commits: MemoryCommit[] = [];
    for (const line of result.stdout.split('\n')) {
      if (line.trim().length === 0) continue;
      const parts = line.split('\t');
      const sha = parts[0]?.trim() ?? '';
      if (sha.length === 0) continue;
      commits.push({
        sha,
        date: parts[1]?.trim() ?? '',
        message: parts.slice(2).join('\t').trim(),
      });
    }
    return commits;
  }

  async revert(sha: string): Promise<boolean> {
    return this.serialize(async () => {
      if (!(await this.ensureRepo())) return false;
      const result = await this.run([
        '-c',
        `user.name=${MEMORY_AUTHOR_NAME}`,
        '-c',
        `user.email=${MEMORY_AUTHOR_EMAIL}`,
        'revert',
        '--no-edit',
        sha,
      ]);
      if (!result.ok) {
        this.log.warn('memory repo revert failed', { dir: this.dir, sha });
        return false;
      }
      return true;
    });
  }
}

registerScopedService(
  LifecycleScope.App,
  IMemoryRepo,
  MemoryRepo,
  ScopeActivation.OnScopeCreated,
  'memoryRepo',
);
