import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { defineKlientConformance } from './helpers/conformance.js';
import { createKlient, serveKlientIpc, type KlientIpcHost } from '../src/transports/ipc/index.js';
import { makeEngine, type TestEngine } from './helpers/engine.js';

// Windows cannot listen on Unix-socket paths at all (Node throws EACCES),
// so the whole socket-behavior suite is POSIX-only.
if (process.platform !== 'win32') {
  defineKlientConformance('ipc', async () => {
  const { homeDir, app } = await makeEngine();
  const socketPath = join(homeDir, 'klient.sock');
  const host = await serveKlientIpc({ scope: app, socketPath });
  const klient = createKlient({ socketPath, token: host.token });
  return {
    klient,
    app,
    cleanup: async () => {
      await klient.close();
      await host.close();
      app.dispose();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    },
  };
  });
}

// Windows cannot listen on Unix-socket paths at all (Node throws EACCES),
// so the whole socket-behavior suite is POSIX-only.
describe.skipIf(process.platform === 'win32')('ipc transport specifics', () => {
  let homeDir: string;
  let app: TestEngine['app'];
  let host: KlientIpcHost | undefined;

  async function setup(opts: { token?: string } = {}): Promise<string> {
    ({ homeDir, app } = await makeEngine());
    const socketPath = join(homeDir, 'klient.sock');
    host = await serveKlientIpc({ scope: app, socketPath, token: opts.token });
    return socketPath;
  }

  async function teardown(): Promise<void> {
    await host?.close();
    host = undefined;
    app.dispose();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }

  it('rejects calls when the socket path does not exist', async () => {
    const klient = createKlient({ socketPath: join(tmpdir(), 'klient-no-such.sock') });
    await expect(klient.global.env()).rejects.toThrow();
    await klient.close();
  });

  it('rejects calls made after close', async () => {
    const socketPath = await setup();
    const klient = createKlient({ socketPath, token: host?.token });
    await klient.global.env();
    await klient.close();
    // env() is served from its frozen-snapshot cache after the first call, so
    // probe the closed channel with an uncached method instead.
    await expect(klient.global.workspaces.list()).rejects.toThrow('ipc closed');
    await teardown();
  });

  it('generates a token when none is supplied and rejects token-less clients', async () => {
    const socketPath = await setup();
    expect(host?.token).toBeTypeOf('string');
    expect(host?.token.length).toBeGreaterThan(0);

    // A client without the token must be refused even though the host did
    // not configure one explicitly.
    const noToken = createKlient({ socketPath });
    await expect(noToken.global.env()).rejects.toThrow();
    await noToken.close();

    const withToken = createKlient({ socketPath, token: host?.token });
    await expect(withToken.global.env()).resolves.toMatchObject({ platform: process.platform });
    await withToken.close();
    await teardown();
  });

  it('refuses to remove a non-socket file at the socket path', async () => {
    const target = join(tmpdir(), `klient-ipc-not-socket-${Date.now()}.txt`);
    await writeFile(target, 'precious data');
    try {
      await expect(
        serveKlientIpc({ scope: await makeEngine().then((e) => e.app), socketPath: target }),
      ).rejects.toThrow('not a socket');
      // The file must be untouched.
      await expect(readFile(target, 'utf8')).resolves.toBe('precious data');
    } finally {
      await rm(target, { force: true });
    }
  });

  it('drops clients whose hello token mismatches', async () => {
    const socketPath = await setup({ token: 'right' });
    const klient = createKlient({ socketPath, token: 'wrong' });
    await expect(klient.global.env()).rejects.toThrow();
    await klient.close();

    const ok = createKlient({ socketPath, token: 'right' });
    await expect(ok.global.env()).resolves.toMatchObject({ platform: process.platform });
    await ok.close();
    await teardown();
  });
});
