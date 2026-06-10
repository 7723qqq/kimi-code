

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Stats } from 'node:fs';

import { Disposable, InstantiationType, registerSingleton } from '@moonshot-ai/agent-core';
import { encodeWorkDirKey } from '@moonshot-ai/agent-core/session/store';
import { IEnvironmentService } from '../environment/environment';

import type { Workspace } from '@moonshot-ai/protocol';

import { ILogService } from '../logger/logger';
import {
  IWorkspaceRegistry,
  WorkspaceNotFoundError,
  WorkspaceRootNotFoundError,
  type WorkspacePatch,
} from './workspaceRegistry';

const WORKSPACE_FILE = 'workspace.json';
const WORKSPACE_FILE_VERSION = 1;

interface WorkspaceFile {
  version: number;
  root: string;
  name: string;
  created_at: string;
  last_opened_at: string;
}

export class WorkspaceRegistryService extends Disposable implements IWorkspaceRegistry {
  readonly _serviceBrand: undefined;

  private readonly sessionsDir: string;

  constructor(
    @IEnvironmentService env: IEnvironmentService,
    @ILogService private readonly logger: ILogService,
  ) {
    super();
    this.sessionsDir = join(env.homeDir, 'sessions');
  }

  async list(): Promise<Workspace[]> {
    let dirents;
    try {
      dirents = await fsp.readdir(this.sessionsDir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      throw err;
    }
    const candidates: { workspaceId: string; dir: string }[] = [];
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      if (!d.name.startsWith('wd_')) continue;
      candidates.push({
        workspaceId: d.name,
        dir: join(this.sessionsDir, d.name),
      });
    }
    const hydrated = await Promise.all(
      candidates.map(async ({ workspaceId, dir }) => {
        const file = await this.readFile(dir);
        if (file === null) return null;
        const [{ is_git_repo, branch }, session_count] = await Promise.all([
          detectGit(file.root),
          countSessionDirs(dir),
        ]);
        const ws: Workspace = {
          id: workspaceId,
          root: file.root,
          name: file.name,
          is_git_repo,
          branch,
          created_at: file.created_at,
          last_opened_at: file.last_opened_at,
          session_count,
        };
        return ws;
      }),
    );
    return hydrated
      .filter((ws): ws is Workspace => ws !== null)
      .sort((a, b) => (b.last_opened_at < a.last_opened_at ? -1 : 1));
  }

  async get(workspaceId: string): Promise<Workspace> {
    const dir = join(this.sessionsDir, workspaceId);
    const file = await this.readFile(dir);
    if (file === null) {
      throw new WorkspaceNotFoundError(workspaceId);
    }
    const [{ is_git_repo, branch }, session_count] = await Promise.all([
      detectGit(file.root),
      countSessionDirs(dir),
    ]);
    return {
      id: workspaceId,
      root: file.root,
      name: file.name,
      is_git_repo,
      branch,
      created_at: file.created_at,
      last_opened_at: file.last_opened_at,
      session_count,
    };
  }

  async createOrTouch(root: string, name?: string): Promise<Workspace> {
    let realRoot: string;
    try {
      realRoot = await fsp.realpath(root);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new WorkspaceRootNotFoundError(root);
      }
      throw err;
    }
    const workspaceId = encodeWorkDirKey(realRoot);
    const dir = join(this.sessionsDir, workspaceId);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });

    const now = new Date().toISOString();
    let existing = await this.readFile(dir);
    let file: WorkspaceFile;
    if (existing !== null) {
      file = { ...existing, last_opened_at: now };
    } else {
      file = {
        version: WORKSPACE_FILE_VERSION,
        root: realRoot,
        name: name ?? basename(realRoot),
        created_at: now,
        last_opened_at: now,
      };
    }
    await this.writeFile(dir, file);

    const [{ is_git_repo, branch }, session_count] = await Promise.all([
      detectGit(realRoot),
      countSessionDirs(dir),
    ]);
    return {
      id: workspaceId,
      root: file.root,
      name: file.name,
      is_git_repo,
      branch,
      created_at: file.created_at,
      last_opened_at: file.last_opened_at,
      session_count,
    };
  }

  async update(workspaceId: string, patch: WorkspacePatch): Promise<Workspace> {
    const dir = join(this.sessionsDir, workspaceId);
    const existing = await this.readFile(dir);
    if (existing === null) {
      throw new WorkspaceNotFoundError(workspaceId);
    }
    const next: WorkspaceFile = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
    };
    await this.writeFile(dir, next);
    const [{ is_git_repo, branch }, session_count] = await Promise.all([
      detectGit(next.root),
      countSessionDirs(dir),
    ]);
    return {
      id: workspaceId,
      root: next.root,
      name: next.name,
      is_git_repo,
      branch,
      created_at: next.created_at,
      last_opened_at: next.last_opened_at,
      session_count,
    };
  }

  async delete(workspaceId: string): Promise<void> {
    const filePath = join(this.sessionsDir, workspaceId, WORKSPACE_FILE);
    try {
      await fsp.unlink(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new WorkspaceNotFoundError(workspaceId);
      }
      throw err;
    }
  }

  async resolveRoot(workspaceId: string): Promise<string> {
    const dir = join(this.sessionsDir, workspaceId);
    const file = await this.readFile(dir);
    if (file === null) {
      throw new WorkspaceNotFoundError(workspaceId);
    }
    return file.root;
  }

  private async readFile(dir: string): Promise<WorkspaceFile | null> {
    const filePath = join(dir, WORKSPACE_FILE);
    let raw: string;
    try {
      raw = await fsp.readFile(filePath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw err;
    }
    let parsed: Partial<WorkspaceFile>;
    try {
      parsed = JSON.parse(raw) as Partial<WorkspaceFile>;
    } catch (err) {
      this.logger.warn(
        { dir, err: String(err) },
        'workspace.json malformed; treating bucket as unregistered',
      );
      return null;
    }
    if (
      typeof parsed.root !== 'string' ||
      typeof parsed.name !== 'string' ||
      typeof parsed.created_at !== 'string' ||
      typeof parsed.last_opened_at !== 'string'
    ) {
      this.logger.warn({ dir }, 'workspace.json missing required keys; treating as unregistered');
      return null;
    }
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      root: parsed.root,
      name: parsed.name,
      created_at: parsed.created_at,
      last_opened_at: parsed.last_opened_at,
    };
  }

  private async writeFile(dir: string, file: WorkspaceFile): Promise<void> {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const final = join(dir, WORKSPACE_FILE);
    const tmp = `${final}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(file, null, 2), 'utf8');
    await fsp.rename(tmp, final);
  }

  override dispose(): void {
    if (this._store.isDisposed) return;
    super.dispose();
  }
}

export interface GitInfo {
  is_git_repo: boolean;
  branch: string | null;
}

export async function detectGit(root: string): Promise<GitInfo> {
  let dotGit: Stats;
  try {
    dotGit = await fsp.lstat(join(root, '.git'));
  } catch {
    return { is_git_repo: false, branch: null };
  }

  let gitDir: string;
  if (dotGit.isDirectory()) {
    gitDir = join(root, '.git');
  } else if (dotGit.isFile()) {
    let text: string;
    try {
      text = await fsp.readFile(join(root, '.git'), 'utf8');
    } catch {
      return { is_git_repo: false, branch: null };
    }
    const m = /^gitdir:\s*(.+)$/m.exec(text);
    if (m === null) return { is_git_repo: false, branch: null };
    const ref = m[1] ?? '';
    if (ref === '') return { is_git_repo: false, branch: null };
    gitDir = ref.trim();

    if (!gitDir.startsWith('/')) {
      gitDir = join(root, gitDir);
    }
  } else {
    return { is_git_repo: false, branch: null };
  }

  let head: string;
  try {
    head = (await fsp.readFile(join(gitDir, 'HEAD'), 'utf8')).trim();
  } catch {
    return { is_git_repo: true, branch: null };
  }
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
  return { is_git_repo: true, branch: ref ? (ref[1] ?? null) : null };
}

async function countSessionDirs(dir: string): Promise<number> {
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 0;
    throw err;
  }
  let count = 0;
  for (const d of dirents) {
    if (d.isDirectory()) count += 1;
  }
  return count;
}

export function userHomeDir(): string {
  return os.homedir();
}

export const pathDirname = dirname;

registerSingleton(IWorkspaceRegistry, WorkspaceRegistryService, InstantiationType.Delayed);
