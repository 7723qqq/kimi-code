import { afterEach, expect, it } from 'bun:test';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { rejectionOf } from '../../../../../packages/vite-preset/test/promises';
import { BunBackend, resolveBackendLaunch } from '../../../src/main/server/bun-backend';
import { BackendChannel } from '../../../src/shared/backend-channel';
import {
  BACKEND_MAX_FRAME_BYTES,
  BackendProtocolError,
  BackendRequestError,
  parseBackendFrame,
  type BackendInput,
} from '../../../src/shared/backend-protocol';

const channels: BackendChannel[] = [];
afterEach(() => {
  for (const channel of channels.splice(0)) channel.close();
});

function pair() {
  const parentInput = new PassThrough();
  const childInput = new PassThrough();
  const parent = new BackendChannel('electron', parentInput, childInput);
  const child = new BackendChannel('bun', childInput, parentInput);
  channels.push(parent, child);
  return { parent, child, parentInput, childInput };
}

function startup(): BackendInput<'start'> {
  return {
    homeDir: process.cwd(),
    serverVersion: '2.7.0',
    deviceId: 'fixture-device',
    hostIdentity: {
      productName: 'fixture-desktop',
      version: '1.4.0',
      platform: 'fixture',
      displayName: 'Fixture',
      replyStyleGuide: 'Fixture',
    },
    debugEndpoints: false,
    authSecret: 'a'.repeat(43),
    browser: { revision: 0, agent: true, subagent: true },
  };
}

it('pairs requests in both directions and preserves ordered events', async () => {
  const { parent, child } = pair();
  const seen: number[] = [];
  child.on('browser.settings', ({ revision }) => {
    seen.push(revision);
  });
  parent.handle('browser.collect-dialogs', () => null);
  child.handle('telemetry.session-count', async () => {
    expect(await child.request('browser.collect-dialogs', { sessionId: 'fixture' })).toBeNull();
    return seen.length;
  });
  await parent.emit('browser.settings', { revision: 1, agent: true, subagent: true });
  await parent.emit('browser.settings', { revision: 2, agent: false, subagent: false });
  expect(await parent.request('telemetry.session-count', null)).toBe(2);
  expect(seen).toEqual([1, 2]);
});

it('cancels pending requests, aborts the handler, and accepts only its one late reply', async () => {
  const { parent, child, parentInput } = pair();
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  let stopped = false;
  child.handle('telemetry.session-count', async (_input, signal) => {
    started();
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        'abort',
        () => {
          stopped = true;
          resolve();
        },
        { once: true },
      ),
    );
    return 0;
  });
  const abort = new AbortController();
  const result = parent
    .request('telemetry.session-count', null, { signal: abort.signal })
    .catch((error) => error);
  await running;
  abort.abort();
  expect(await result).toBeInstanceOf(BackendRequestError);
  await new Promise((resolve) => setImmediate(resolve));
  await child.drain();
  expect(stopped).toBe(true);
  expect(parent.connected).toBe(true);
  parentInput.write(
    JSON.stringify({ version: 1, type: 'result', id: 1, ok: true, value: 0 }) + '\n',
  );
  expect(parent.connected).toBe(false);
});

it.each([
  { version: 99, type: 'cancel', id: 1 },
  { version: 1, type: 'request', id: 1, method: 'eval', input: null },
  { version: 1, type: 'request', id: 1, method: 'shutdown', input: { unexpected: true } },
  { version: 1, type: 'result', id: 500, ok: true, value: null },
])('fails closed for unsupported or malformed frames %#', async (frame) => {
  const { parent, childInput } = pair();
  const pending = parent.request('telemetry.session-count', null).catch((error) => error);
  childInput.write(JSON.stringify(frame) + '\n');
  expect(await pending).toBeInstanceOf(Error);
  expect(parent.connected).toBe(false);
});

it('rejects pending requests on EOF and rejects new requests after close', async () => {
  const { parent, child, parentInput } = pair();
  child.handle('telemetry.session-count', () => new Promise<number>(() => {}));
  const pending = parent.request('telemetry.session-count', null).catch((error) => error);
  parentInput.end();
  expect((await pending).message).toContain('EOF');
  const later = await parent.request('telemetry.session-count', null).catch((error) => error);
  expect(later).toBeInstanceOf(Error);
});

it('rejects incomplete and oversized input and bounds pending requests', async () => {
  const incomplete = pair();
  incomplete.parentInput.end('{');
  expect(incomplete.parent.connected).toBe(false);
  const oversized = pair();
  oversized.parentInput.write('x'.repeat(BACKEND_MAX_FRAME_BYTES + 1));
  expect(oversized.parent.connected).toBe(false);
  const { parent, child } = pair();
  child.handle('telemetry.session-count', () => new Promise<number>(() => {}));
  const pending = Array.from({ length: 128 }, () =>
    parent.request('telemetry.session-count', null).catch((error) => error),
  );
  expect(
    ((error: unknown) => () => {
      throw error;
    })(await rejectionOf(Promise.resolve(parent.request('telemetry.session-count', null)))),
  ).toThrow('limit');
  parent.close();
  await Promise.all(pending);
});

it('does not echo malformed content or secrets in protocol errors', () => {
  const secret = 'not-a-public-secret';
  let failure: unknown;
  try {
    parseBackendFrame(secret);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(BackendProtocolError);
  expect(String(failure)).not.toContain(secret);
});

it('requires an explicit development Bun executable and ignores PATH for packaged launch', () => {
  expect(() =>
    resolveBackendLaunch({ packaged: false, resourcesPath: process.cwd(), appPath: process.cwd() }),
  ).toThrow('explicit Bun');
  const launch = resolveBackendLaunch({
    packaged: false,
    resourcesPath: process.cwd(),
    appPath: process.cwd(),
    bunPath: process.execPath,
  });
  expect(launch.command).toBe(process.execPath);
  expect(launch.args).toContain('--no-env-file');
  expect(launch.args.at(-1)).toEndWith('launcher.ts');
  expect(() =>
    resolveBackendLaunch({
      packaged: true,
      resourcesPath: '/fixture/missing-resources',
      appPath: process.cwd(),
      bunPath: process.execPath,
    }),
  ).toThrow();
});

it('closes the owned process once and waits for its actual exit', async () => {
  const backend = new BunBackend(
    {
      command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/backend-process.ts', import.meta.url))],
      cwd: process.cwd(),
    },
    () => {},
  );
  try {
    const ready = await backend.start(startup());
    expect(ready.runtime).toEqual({ name: 'bun', version: process.versions.bun });
    const closing = backend.close();
    expect(backend.close()).toBe(closing);
    await closing;
    await backend.exited;
    expect(backend.connected).toBe(false);
  } finally {
    await backend.close();
  }
});

for (const mode of ['reject', 'cancel'] as const) {
  it(`cleans up and waits for child exit when startup must ${mode}`, async () => {
    const abort = new AbortController();
    const backend = new BunBackend(
      {
        command: process.execPath,
        args: [fileURLToPath(new URL('./fixtures/backend-process.ts', import.meta.url)), mode],
        cwd: process.cwd(),
      },
      () => {},
    );
    backend.channel.handle('browser.collect-dialogs', () => {
      abort.abort();
      return null;
    });
    try {
      expect(
        await rejectionOf(Promise.resolve(backend.start(startup(), abort.signal))),
      ).toBeInstanceOf(Error);
      await backend.exited;
      expect(backend.connected).toBe(false);
    } finally {
      await backend.close();
    }
  });
}
