import { request } from 'node:http';

import { expect, it } from 'bun:test';

import { installNetworkGuard } from '#/fixtures/network';
import type { KapLaunchOptions, KapRunningServer } from '#/kap/harness';
import { fixtureTest, kapFixtures, type KapFixtures } from '#/bun/index';

function requestError(host = 'blocked.example.test'): Promise<Error> {
  return new Promise<Error>((resolve) => {
    request({
      host,
      port: 443,
      lookup: (_hostname, _options, callback) => callback(new Error('lookup disabled in this test'), '', 0),
    }).once('error', resolve).end();
  });
}

it('handles the connection error in the test body', async () => {
  expect(await requestError()).toBeInstanceOf(Error);
});

it('uninstalls a nested guard after inspecting the violation', async () => {
  const nested = installNetworkGuard();
  try {
    expect(await requestError()).toMatchObject({ code: 'ECONNREFUSED' });
    expect(nested.violations()).toEqual(['blocked.example.test:443']);
    expect(() => nested.assertNoViolations()).toThrow(/non-loopback address/);
  } finally {
    nested.uninstall();
  }
});

const withLabel = fixtureTest<{ label: string }>({
  label: async ({ task }, use) => {
    await requestError('setup.example.test');
    await use(task.name);
    await requestError('teardown.example.test');
  },
});

withLabel('uses a fixture that handles connection errors while starting and stopping', ({ label }) => {
  expect(label).toContain('uses a fixture');
});

const kapTest = fixtureTest<KapFixtures<KapRunningServer>>(kapFixtures({
  createServerLogger: ({ stream }) => stream,
  startServer: (options: KapLaunchOptions & { logger?: { write(line: string): void } }) => {
    options.logger?.write(JSON.stringify({ msg: 'network diagnostic server started' }));
    return Promise.resolve({ host: '127.0.0.1', port: 9, close: () => Promise.resolve() });
  },
}));

kapTest('reports KAP diagnostics for a network failure', async ({ kap }) => {
  expect(kap.server.host).toBe('127.0.0.1');
  await requestError();
});

it.each(['first', 'second'] as const)('removes the %s installation and retains the other host permissions', async (remove) => {
  const shared = 'shared.example.test';
  const guards = {
    first: installNetworkGuard({ allowHosts: ['first.example.test', shared, shared.toUpperCase()] }),
    second: installNetworkGuard({ allowHosts: ['second.example.test', shared.toUpperCase()] }),
  };
  const keep = remove === 'first' ? 'second' : 'first';
  const forwarded = { message: 'lookup disabled in this test' };
  try {
    for (const host of ['first.example.test', 'second.example.test', shared]) {
      expect(await requestError(host)).toMatchObject(forwarded);
    }
    guards[remove].uninstall();
    guards[remove].uninstall();
    expect(await requestError(`${remove}.example.test`)).toMatchObject({ code: 'ECONNREFUSED' });
    expect(await requestError(`${keep}.example.test`)).toMatchObject(forwarded);
    expect(await requestError(shared)).toMatchObject(forwarded);
    guards[keep].uninstall();
    expect(await requestError(shared)).toMatchObject({ code: 'ECONNREFUSED' });
  } finally {
    guards.first.uninstall();
    guards.second.uninstall();
  }
});

it('blocks Bun fetch before DNS even when the request is already aborted', async () => {
  const error = await fetch('https://fetch.example.test:8443/path', { signal: AbortSignal.abort() }).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: 'ECONNREFUSED' });
});

it('blocks Bun fetch preconnect without dropping the native helper', () => {
  expect(typeof fetch.preconnect).toBe('function');
  expect(() => fetch.preconnect('https://preconnect.example.test')).toThrow('network guard blocked a connection to preconnect.example.test:443');
});

it('starts the next test with no violations', () => {
  const nested = installNetworkGuard();
  try {
    expect(nested.violations()).toEqual([]);
  } finally {
    nested.uninstall();
  }
});
