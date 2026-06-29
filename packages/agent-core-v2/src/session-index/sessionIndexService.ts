/**
 * `session-index` domain (L2) — `FileSessionIndex` implementation.
 *
 * Reads the persisted session set through the `storage` access-pattern stores,
 * rooted at the `sessionsDir` path layout fact from `bootstrap`. The directory
 * tree `<sessionsDir>/<workspaceId>/<sessionId>/session-meta/state.json` is the
 * index: workspace and session ids are enumerated via `IStorageService.list`,
 * and each session's `state.json` is read via `IAtomicDocumentStore` to build
 * its summary. This is the local-deployment backend of `ISessionIndex`; a
 * server deployment would substitute a database-backed `DbSessionIndex`. Bound
 * at Core scope.
 */

import { relative } from 'pathe';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/bootstrap';
import { IAtomicDocumentStore, IStorageService, type Page } from '#/storage';

import { ISessionIndex, type SessionListQuery, type SessionSummary } from './sessionIndex';

const META_SCOPE = 'session-meta';
const META_KEY = 'state.json';

export class FileSessionIndex implements ISessionIndex {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IStorageService private readonly storage: IStorageService,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
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

  private get sessionsScope(): string {
    return relative(this.bootstrap.homeDir, this.bootstrap.sessionsDir);
  }

  private async listWorkspaceIds(): Promise<readonly string[]> {
    try {
      return await this.storage.list(this.sessionsScope);
    } catch {
      return [];
    }
  }

  private async listSessionIds(workspaceId: string): Promise<readonly string[]> {
    try {
      return await this.storage.list(`${this.sessionsScope}/${workspaceId}`);
    } catch {
      return [];
    }
  }

  private async hasSession(workspaceId: string, sessionId: string): Promise<boolean> {
    const ids = await this.listSessionIds(workspaceId);
    return ids.includes(sessionId);
  }

  private async readSummary(
    workspaceId: string,
    sessionId: string,
  ): Promise<SessionSummary | undefined> {
    const scope = `${this.sessionsScope}/${workspaceId}/${sessionId}/${META_SCOPE}`;
    let meta: Record<string, unknown> | undefined;
    try {
      meta = await this.docs.get<Record<string, unknown>>(scope, META_KEY);
    } catch {
      return undefined;
    }
    if (meta === undefined) return undefined;
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
