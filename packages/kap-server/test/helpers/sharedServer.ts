import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IModelCatalog } from '@moonshot-ai/agent-core-v2';

import { startServer, type RunningServer } from '../../src/start';
import { fakeModelCatalog } from './fakeModelCatalog';
import { fixedTokenAuth } from './fixedAuth';
import { TEST_HOST_IDENTITY } from './hostIdentity';

const SHARED_SERVER_TOKEN = 'test-token';

export interface SharedServerContext {
  readonly base: string;
  readonly token: string;
}

let context: SharedServerContext | undefined;
let booting: Promise<SharedServerContext> | undefined;
let running: RunningServer | undefined;
let home: string | undefined;

export async function ensureSharedServer(): Promise<SharedServerContext> {
  if (context !== undefined) return context;
  booting ??= (async () => {
    process.env['KIMI_CODE_SEARCH_WORKER'] = 'false';
    process.env['KIMI_CODE_PERSISTENCE_MINIDB_READMODEL'] = 'false';
    home = await mkdtemp(join(tmpdir(), 'kimi-kap-server-shared-home-'));
    running = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      authTokenService: fixedTokenAuth(SHARED_SERVER_TOKEN),
      seeds: [[IModelCatalog, fakeModelCatalog()]],
    });
    context = {
      base: `http://127.0.0.1:${running.port}`,
      token: SHARED_SERVER_TOKEN,
    };
    return context;
  })();
  return booting;
}

export async function stopSharedServer(): Promise<void> {
  await running?.close();
  running = undefined;
  context = undefined;
  booting = undefined;
  if (home !== undefined) {
    const dir = home;
    home = undefined;
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

export function sharedServer(): SharedServerContext {
  if (context === undefined) throw new Error('shared server is not started; await ensureSharedServer()');
  return context;
}

export function sharedAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, authorization: `Bearer ${sharedServer().token}` };
}

interface SharedFetchOptions {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export async function sharedAuthedFetch(path: string, init: SharedFetchOptions = {}): Promise<Response> {
  return fetch(`${sharedServer().base}${path}`, {
    ...init,
    headers: sharedAuthHeaders(init.headers),
  } as never);
}
