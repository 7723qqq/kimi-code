/**
 * Shared engine bootstrap for klient integration tests. Mirrors what
 * kap-server does: `bootstrap()` plus the `ILogOptions` seed the
 * Session-scoped log writer needs (bare `bootstrap({ homeDir })` leaves
 * `logOptions` unregistered and any eager service depending on `ILogService`
 * fails to instantiate).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  bootstrap,
  drainLogCloses,
  logSeed,
  resolveLoggingConfig,
} from '@moonshot-ai/agent-core-v2';

/** Shared host identity for klient test engines (bootstrap requires one). */
export const TEST_CLIENT_IDENTITY = {
  productName: 'klient-test',
  version: '0.0.0-test',
  platform: 'test',
} as const;

export interface TestEngine {
  readonly homeDir: string;
  readonly app: ReturnType<typeof bootstrap>['app'];
}

export async function makeEngine(prefix = 'klient-test-engine-'): Promise<TestEngine> {
  const homeDir = await mkdtemp(join(tmpdir(), prefix));
  const { app } = bootstrap({ homeDir, clientIdentity: TEST_CLIENT_IDENTITY }, [
    ...logSeed(resolveLoggingConfig({ homeDir, env: process.env })),
  ]);
  return { homeDir, app };
}

/** Errno codes a Windows delete reports while another handle still holds the path. */
const RETRYABLE_UNLINK = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']);

/**
 * Remove a temp directory, retrying the transient Windows share violations.
 * `force` alone does not cover them: the code is reported while a handle is
 * still open, so the attempt has to come back after it closes.
 */
export async function removeTempDir(path: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !RETRYABLE_UNLINK.has(code)) throw error;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 25 * (attempt + 1));
      });
    }
  }
}

/**
 * Tear down a test engine and its temp home.
 *
 * The `app.dispose()` → `drainLogCloses()` → `rm` order is the same one
 * `kap-server`, `node-sdk`, and `acp-server` use at shutdown. `dispose()` only
 * *tracks* the log writer's close promise; the file handle it holds is still
 * open until that promise settles, and on Windows a recursive `rm` of the home
 * directory then fails with `EBUSY`. Tests that skipped the drain raced the
 * writer and failed intermittently under parallel load.
 */
export async function cleanupEngine(engine: TestEngine): Promise<void> {
  engine.app.dispose();
  await drainLogCloses();
  await removeTempDir(engine.homeDir);
}
