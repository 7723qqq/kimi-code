import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  drainQueryStoreDisposals,
  drainSessionIndexMirror,
  IModelCatalog,
} from '@moonshot-ai/agent-core-v2';
import { afterAll, afterEach } from 'bun:test';

import { startServer } from '../src/start';
import { fakeModelCatalog } from './helpers/fakeModelCatalog';
import { fixedTokenAuth } from './helpers/fixedAuth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { setSharedServer } from './helpers/sharedServer';

export const SHARED_SERVER_TOKEN = 'test-token';

for (const key of Object.keys(process.env)) {
  if (key.startsWith('KIMI_CODE_')) {
    delete process.env[key];
  }
}

process.env['KIMI_CODE_SEARCH_WORKER'] = 'false';

process.env['KIMI_CODE_PERSISTENCE_MINIDB_READMODEL'] = 'false';

const sharedHome = await mkdtemp(join(tmpdir(), 'kimi-kap-server-shared-home-'));

const sharedServerHandle = await startServer({
  hostIdentity: TEST_HOST_IDENTITY,
  host: '127.0.0.1',
  port: 0,
  homeDir: sharedHome,
  logLevel: 'silent',
  authTokenService: fixedTokenAuth(SHARED_SERVER_TOKEN),
  seeds: [[IModelCatalog, fakeModelCatalog()]],
});

setSharedServer({
  base: `http://127.0.0.1:${sharedServerHandle.port}`,
  token: SHARED_SERVER_TOKEN,
});

afterEach(async () => {
  await drainSessionIndexMirror();
  await drainQueryStoreDisposals();
});

afterAll(async () => {
  await sharedServerHandle.close();
  await rm(sharedHome, { recursive: true, force: true, maxRetries: 25, retryDelay: 100 }).catch(() => undefined);
});
