/**
 * `session-metadata` domain (L6) — `ISessionMetadata` implementation.
 *
 * Persists the session metadata document (`state.json`) through the `storage`
 * access-pattern store (`IAtomicDocumentStore`), rooted at the `metaScope`
 * namespace from `session-context`. Loads the existing document on
 * construction (creating it on first run), and logs through `log`. Bound at
 * Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { Emitter, type Event } from '#/_base/event';
import { ILogService } from '#/log';
import { ISessionContext } from '#/session-context';
import { IAtomicDocumentStore } from '#/storage';

import { ISessionMetadata, type SessionMeta, type SessionMetaPatch } from './sessionMetadata';

const META_KEY = 'state.json';

export class SessionMetadata extends Disposable implements ISessionMetadata {
  declare readonly _serviceBrand: undefined;
  readonly ready: Promise<void>;
  readonly onDidChange: Event<void>;

  private readonly _onDidChange = this._register(new Emitter<void>());
  private readonly scope: string;
  private data!: SessionMeta;

  constructor(
    @ISessionContext private readonly ctx: ISessionContext,
    @IAtomicDocumentStore private readonly store: IAtomicDocumentStore,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.scope = ctx.metaScope;
    this.onDidChange = this._onDidChange.event;
    this.ready = this.load();
  }

  async read(): Promise<SessionMeta> {
    await this.ready;
    return this.data;
  }

  async update(patch: SessionMetaPatch): Promise<void> {
    await this.ready;
    this.data = { ...this.data, ...patch, updatedAt: Date.now() };
    await this.store.set(this.scope, META_KEY, this.data);
    this._onDidChange.fire();
  }

  async setTitle(title: string): Promise<void> {
    await this.update({ title });
  }

  async setArchived(archived: boolean): Promise<void> {
    await this.update({ archived });
  }

  private async load(): Promise<void> {
    const existing = await this.store.get<SessionMeta>(this.scope, META_KEY);
    if (existing !== undefined) {
      this.data = existing;
      return;
    }
    const now = Date.now();
    this.data = { id: this.ctx.sessionId, createdAt: now, updatedAt: now, archived: false };
    await this.store.set(this.scope, META_KEY, this.data);
    this.log.debug('session metadata created', { sessionId: this.ctx.sessionId });
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionMetadata,
  SessionMetadata,
  InstantiationType.Delayed,
  'session-metadata',
);
