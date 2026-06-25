/**
 * `sessionMetaStore` — session-scope metadata persistence.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ISessionKaosService } from '#/kaos';
import { ILogService } from '#/log';

import { ISessionMetaStore } from './sessionMetaStore';

export class SessionMetaStore extends Disposable implements ISessionMetaStore {
  declare readonly _serviceBrand: undefined;
  private data: Record<string, unknown> = {};
  private readonly path: string;

  constructor(
    @ISessionKaosService private readonly sessionKaos: ISessionKaosService,
    @ILogService _log: ILogService,
    path: string = 'state.json',
  ) {
    super();
    this.path = path;
  }

  async read(): Promise<Record<string, unknown>> {
    try {
      const text = await this.sessionKaos.persistenceKaos.readText(this.path);
      this.data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.data = {};
    }
    return this.data;
  }

  async write(patch: Record<string, unknown>): Promise<void> {
    this.data = { ...this.data, ...patch };
    await this.flush();
  }

  async flush(): Promise<void> {
    await this.sessionKaos.persistenceKaos.writeText(
      this.path,
      JSON.stringify(this.data, null, 2),
    );
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionMetaStore,
  SessionMetaStore,
  InstantiationType.Delayed,
  'records',
);
