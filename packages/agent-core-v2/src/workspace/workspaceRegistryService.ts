/**
 * `workspace` domain (cross-cutting) — `IWorkspaceRegistry` implementation.
 *
 * Persists the process-wide workspace catalog to `<homeDir>/workspaces.json`
 * and hydrates each entry with live git state and an active-session count.
 * Bound at Core scope — one shared registry.
 */

import { promises as fsp } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { Workspace } from '@moonshot-ai/protocol';

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IEnvironmentService } from '#/environment/environment';
import { IEventService } from '#/event/event';
import { ILogService } from '#/log/log';
import { ISessionStore } from '#/sessionStore/sessionStore';

import { WorkspaceError, WorkspaceErrors } from './errors';
import { IWorkspaceRegistry, type WorkspacePatch } from './workspaceRegistry';

const WORKSPACE_REGISTRY_FILE = 'workspaces.json';
const WORKSPACE_REGISTRY_VERSION = 1;

interface WorkspaceRegistryEntry {
  root: string;
  name: string;
  created_at: string;
  last_opened_at: string;
}

interface WorkspaceRegistryFile {
  version: number;
  workspaces: Record<string, WorkspaceRegistryEntry>;
}

export class WorkspaceRegistryService extends Disposable implements IWorkspaceRegistry {
  declare readonly _serviceBrand: undefined;

  private readonly sessionsDir: string;
  private readonly registryPath: string;
  private opQueue: Promise<unknown> = Promise.resolve();

  constructor(
    @IEnvironmentService env: IEnvironmentService,
    @ILogService private readonly logger: ILogService,
    @IEventService private readonly eventService: IEventService,
    @ISessionStore private readonly sessionStore: ISessionStore,
  ) {
    super();
    this.sessionsDir = join(env.homeDir, 'sessions');
    this.registryPath = join(env.homeDir, WORKSPACE_REGISTRY_FILE);
  }

  async list(): Promise<Workspace[]> {
    const file = await this.runExclusive(() => this.readRegistry());
    const hydrated = await Promise.all(
      Object.entries(file.workspaces).map(([workspaceId, entry]) => this.hydrate(workspaceId, entry)),
    );
    return hydrated.sort((a, b) => (b.last_opened_at < a.last_opened_at ? -1 : 1));
  }

  async get(workspaceId: string): Promise<Workspace> {
    const entry = await this.runExclusive(async () => {
      const file = await this.readRegistry();
      return file.workspaces[workspaceId] ?? null;
    });
    if (entry === null) {
      throw new WorkspaceError(WorkspaceErrors.codes.WORKSPACE_NOT_FOUND, `workspace not found: ${workspaceId}`, {
        workspaceId,
      });
    }
    return this.hydrate(workspaceId, entry);
  }

  async createOrTouch(root: string, name?: string): Promise<Workspace> {
    let realRoot: string;
    try {
      realRoot = await fsp.realpath(root);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new WorkspaceError(WorkspaceErrors.codes.PATH_NOT_FOUND, `workspace root does not exist: ${root}`, {
          root,
        });
      }
      throw err;
    }
    const workspaceId = this.sessionStore.workspaceIdFor(realRoot);
    await fsp.mkdir(join(this.sessionsDir, workspaceId), { recursive: true, mode: 0o700 });

    const now = new Date().toISOString();
    const { entry, created } = await this.runExclusive(async () => {
      const file = await this.readRegistry();
      const existing = file.workspaces[workspaceId];
      const next: WorkspaceRegistryEntry =
        existing !== undefined
          ? { ...existing, last_opened_at: now }
          : {
              root: realRoot,
              name: name ?? basename(realRoot),
              created_at: now,
              last_opened_at: now,
            };
      file.workspaces[workspaceId] = next;
      await this.writeRegistry(file);
      return { entry: next, created: existing === undefined };
    });
    const workspace = await this.hydrate(workspaceId, entry);
    if (created) {
      this.eventService.publish({ type: 'event.workspace.created', payload: { workspace } });
    }
    return workspace;
  }

  async update(workspaceId: string, patch: WorkspacePatch): Promise<Workspace> {
    const entry = await this.runExclusive(async () => {
      const file = await this.readRegistry();
      const existing = file.workspaces[workspaceId];
      if (existing === undefined) {
        throw new WorkspaceError(WorkspaceErrors.codes.WORKSPACE_NOT_FOUND, `workspace not found: ${workspaceId}`, {
          workspaceId,
        });
      }
      const next: WorkspaceRegistryEntry = {
        ...existing,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
      };
      file.workspaces[workspaceId] = next;
      await this.writeRegistry(file);
      return next;
    });
    const workspace = await this.hydrate(workspaceId, entry);
    this.eventService.publish({ type: 'event.workspace.updated', payload: { workspace } });
    return workspace;
  }

  async delete(workspaceId: string): Promise<void> {
    const root = await this.runExclusive(async () => {
      const file = await this.readRegistry();
      const existing = file.workspaces[workspaceId];
      if (existing === undefined) {
        throw new WorkspaceError(WorkspaceErrors.codes.WORKSPACE_NOT_FOUND, `workspace not found: ${workspaceId}`, {
          workspaceId,
        });
      }
      delete file.workspaces[workspaceId];
      await this.writeRegistry(file);
      return existing.root;
    });
    this.eventService.publish({ type: 'event.workspace.deleted', payload: { workspace_id: workspaceId, root } });
  }

  async resolveRoot(workspaceId: string): Promise<string> {
    const entry = await this.runExclusive(async () => {
      const file = await this.readRegistry();
      return file.workspaces[workspaceId] ?? null;
    });
    if (entry === null) {
      throw new WorkspaceError(WorkspaceErrors.codes.WORKSPACE_NOT_FOUND, `workspace not found: ${workspaceId}`, {
        workspaceId,
      });
    }
    return entry.root;
  }

  private async hydrate(workspaceId: string, entry: WorkspaceRegistryEntry): Promise<Workspace> {
    const [{ is_git_repo, branch }, session_count] = await Promise.all([
      detectGit(entry.root),
      this.sessionStore.countActiveSessions(this.sessionsDir, entry.root),
    ]);
    return {
      id: workspaceId,
      root: entry.root,
      name: entry.name,
      is_git_repo,
      branch,
      created_at: entry.created_at,
      last_opened_at: entry.last_opened_at,
      session_count,
    };
  }

  private async readRegistry(): Promise<WorkspaceRegistryFile> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.registryPath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { version: WORKSPACE_REGISTRY_VERSION, workspaces: {} };
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn('workspaces.json malformed; treating as empty', {
        path: this.registryPath,
        err: String(err),
      });
      return { version: WORKSPACE_REGISTRY_VERSION, workspaces: {} };
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { workspaces?: unknown }).workspaces !== 'object' ||
      (parsed as { workspaces?: unknown }).workspaces === null
    ) {
      this.logger.warn('workspaces.json missing required keys; treating as empty', {
        path: this.registryPath,
      });
      return { version: WORKSPACE_REGISTRY_VERSION, workspaces: {} };
    }
    const rawWorkspaces = (parsed as { workspaces: Record<string, unknown> }).workspaces;
    const workspaces: Record<string, WorkspaceRegistryEntry> = {};
    for (const [id, value] of Object.entries(rawWorkspaces)) {
      const entry = this.sanitizeEntry(value);
      if (entry !== null) {
        workspaces[id] = entry;
      }
    }
    const version =
      typeof (parsed as { version?: unknown }).version === 'number'
        ? (parsed as { version: number }).version
        : WORKSPACE_REGISTRY_VERSION;
    return { version, workspaces };
  }

  private sanitizeEntry(value: unknown): WorkspaceRegistryEntry | null {
    if (typeof value !== 'object' || value === null) return null;
    const v = value as Partial<WorkspaceRegistryEntry>;
    if (
      typeof v.root !== 'string' ||
      typeof v.name !== 'string' ||
      typeof v.created_at !== 'string' ||
      typeof v.last_opened_at !== 'string'
    ) {
      return null;
    }
    return {
      root: v.root,
      name: v.name,
      created_at: v.created_at,
      last_opened_at: v.last_opened_at,
    };
  }

  private async writeRegistry(file: WorkspaceRegistryFile): Promise<void> {
    await fsp.mkdir(dirname(this.registryPath), { recursive: true, mode: 0o700 });
    const tmp = `${this.registryPath}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(file, null, 2), 'utf8');
    await fsp.rename(tmp, this.registryPath);
  }

  private runExclusive<T>(op: () => Promise<T>): Promise<T> {
    const next = this.opQueue.then(op, op);
    this.opQueue = next.then(
      () => {},
      () => {},
    );
    return next;
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

registerScopedService(
  LifecycleScope.Core,
  IWorkspaceRegistry,
  WorkspaceRegistryService,
  InstantiationType.Delayed,
  'workspace',
);
