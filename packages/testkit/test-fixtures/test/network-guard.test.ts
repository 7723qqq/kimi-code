import { request } from 'node:http';

import { expect, it } from 'bun:test';

import { installNetworkGuard } from '#/fixtures/network';

function requestError(host = 'blocked.example.test'): Promise<Error> {
  return new Promise<Error>((resolve) => {
    request({
      host,
      port: 443,
      lookup: (_hostname, _options, callback) =>
        callback(new Error('lookup disabled in this test'), '', 0),
    })
      .once('error', resolve)
      .end();
  });
}

it('handles the connection error in the test body', async () => {
  const error = await requestError();
  expect(error).toBeInstanceOf(Error);
});

it('uninstalls a nested guard after inspecting the violation', async () => {
  const nested = installNetworkGuard();
  try {
    const error = await requestError();
    expect(error).toMatchObject({ code: 'ECONNREFUSED' });
    expect(nested.violations()).toEqual(['blocked.example.test:443']);
    expect(() => nested.assertNoViolations()).toThrow(/non-loopback address/);
  } finally {
    nested.uninstall();
  }
});

it('starts the next test with no violations', () => {
  const nested = installNetworkGuard();
  try {
    expect(nested.violations()).toEqual([]);
  } finally {
    nested.uninstall();
  }
});
