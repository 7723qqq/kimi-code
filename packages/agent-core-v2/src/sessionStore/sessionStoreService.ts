/**
 * `sessionStore` — core-scope session directory store.
 */

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

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

  workspaceIdFor(workDir: string): string {
    return encodeWorkDirKey(workDir);
  }

  async countActiveSessions(sessionsRoot: string, workDir: string): Promise<number> {
    const dir = join(sessionsRoot, encodeWorkDirKey(workDir));
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
      if (!d.isDirectory()) continue;
      if (await isSessionArchived(join(dir, d.name))) continue;
      count += 1;
    }
    return count;
  }
}

async function isSessionArchived(sessionDir: string): Promise<boolean> {
  try {
    const raw = await fsp.readFile(join(sessionDir, 'state.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { archived?: boolean }).archived === true
    );
  } catch {
    // Treat unreadable/missing state.json as non-archived so the directory still
    // counts as a session (matches the session store's own loading behavior).
    return false;
  }
}

registerScopedService(
  LifecycleScope.Core,
  ISessionStore,
  SessionStore,
  InstantiationType.Delayed,
  'records',
);
