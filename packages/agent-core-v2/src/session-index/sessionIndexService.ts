/**
 * `session-index` domain (L2) — `FileSessionIndex` implementation.
 *
 * Reads the persisted session set from the local filesystem through the
 * program side `hostFs` primitives, rooted at the `sessionsDir` path layout
 * fact from `bootstrap`. The directory tree
 * `<sessionsDir>/<workspaceId>/<sessionId>/session-meta/state.json` is the
 * index: each session's `state.json` is read to build its summary. This is the
 * local-deployment backend of `ISessionIndex`; a server deployment would
 * substitute a database-backed `DbSessionIndex`. Bound at Core scope.
 */

import { join } from 'node:path';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/bootstrap';
import { IHostFileSystem } from '#/hostFs';
import type { Page } from '#/storage';

import { ISessionIndex, type SessionListQuery, type SessionSummary } from './sessionIndex';

const META_SCOPE = 'session-meta';
const META_KEY = 'state.json';

export class FileSessionIndex implements ISessionIndex {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {}

  async list(query: SessionListQuery): Promise<Page<SessionSummary>> {
    const workspaceIds =
      query.workspaceId !== undefined ? [query.workspaceId] : await this.listWorkspaceIds();
    const items: SessionSummary[] = [];
    for (const workspaceId of workspaceIds) {
      for (const sessionId of await this.listSessionIds(workspaceId)) {
        const summary = await this.readSummary(workspaceId, sessionId);
        if (summary === undefined) continue;
        if (summary.archived && query.includeArchived !== true) continue;
        items.push(summary);
      }
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return { items: query.limit !== undefined ? items.slice(0, query.limit) : items };
  }

  async get(id: string): Promise<SessionSummary | undefined> {
    for (const workspaceId of await this.listWorkspaceIds()) {
      if (!(await this.hasSession(workspaceId, id))) continue;
      const summary = await this.readSummary(workspaceId, id);
      if (summary !== undefined) return summary;
    }
    return undefined;
  }

  async countActive(workspaceId: string): Promise<number> {
    let count = 0;
    for (const sessionId of await this.listSessionIds(workspaceId)) {
      const summary = await this.readSummary(workspaceId, sessionId);
      if (summary !== undefined && !summary.archived) count += 1;
    }
    return count;
  }

  private get sessionsDir(): string {
    return this.bootstrap.sessionsDir;
  }

  private async listWorkspaceIds(): Promise<readonly string[]> {
    let entries;
    try {
      entries = await this.hostFs.readdir(this.sessionsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return entries.filter((entry) => entry.isDirectory).map((entry) => entry.name);
  }

  private async listSessionIds(workspaceId: string): Promise<readonly string[]> {
    let entries;
    try {
      entries = await this.hostFs.readdir(join(this.sessionsDir, workspaceId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return entries.filter((entry) => entry.isDirectory).map((entry) => entry.name);
  }

  private async hasSession(workspaceId: string, sessionId: string): Promise<boolean> {
    const ids = await this.listSessionIds(workspaceId);
    return ids.includes(sessionId);
  }

  private async readSummary(
    workspaceId: string,
    sessionId: string,
  ): Promise<SessionSummary | undefined> {
    const metaPath = join(this.sessionsDir, workspaceId, sessionId, META_SCOPE, META_KEY);
    let raw: string;
    try {
      raw = await this.hostFs.readText(metaPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    return {
      id: sessionId,
      workspaceId,
      title: typeof meta['title'] === 'string' ? meta['title'] : undefined,
      createdAt: typeof meta['createdAt'] === 'number' ? meta['createdAt'] : 0,
      updatedAt: typeof meta['updatedAt'] === 'number' ? meta['updatedAt'] : 0,
      archived: meta['archived'] === true,
    };
  }
}

registerScopedService(
  LifecycleScope.Core,
  ISessionIndex,
  FileSessionIndex,
  InstantiationType.Delayed,
  'session-index',
);
