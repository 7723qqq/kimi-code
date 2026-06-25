/**
 * `sessionStore` — core-scope session directory store.
 */

import { createHash } from 'node:crypto';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { slugifyWorkDirName } from '#/_base/utils/workdir-slug';
import { IKaosFactory } from '#/kaos';

import { ISessionStore } from './sessionStore';

const WORKDIR_KEY_PREFIX = 'wd_';
const HASH_LENGTH = 12;

export function encodeWorkDirKey(workDir: string): string {
  const normalized = workDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = normalized.split('/').pop() ?? normalized;
  const slug = slugifyWorkDirName(base);
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, HASH_LENGTH);
  return `${WORKDIR_KEY_PREFIX}${slug}_${hash}`;
}

export class SessionStore implements ISessionStore {
  declare readonly _serviceBrand: undefined;
  constructor(@IKaosFactory _kaosFactory: IKaosFactory) {}

  sessionDir(sessionsRoot: string, workDir: string, sessionId: string): string {
    return `${sessionsRoot}/${encodeWorkDirKey(workDir)}/${sessionId}`;
  }

  read(_sessionId: string): Promise<unknown> {
    throw new Error('TODO: SessionStore.read');
  }
  write(_sessionId: string, _data: unknown): Promise<void> {
    throw new Error('TODO: SessionStore.write');
  }
}

registerScopedService(
  LifecycleScope.Core,
  ISessionStore,
  SessionStore,
  InstantiationType.Delayed,
  'records',
);
