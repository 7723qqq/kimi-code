import { afterEach, expect, it, mock } from 'bun:test';
import { PassThrough } from 'node:stream';

import { rejectionOf } from '../../../../../packages/vite-preset/test/promises';
import { BackendBrowserSettings } from '../../../src/backend/browser-settings';
import { BrowserSubagentRunRegistry } from '../../../src/backend/browser-subagent-control';
import { BunBrowserBridge, type BunBrowserHost } from '../../../src/main/server/bun-browser';
import { BackendChannel } from '../../../src/shared/backend-channel';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

function bridge(validateOwner = () => true) {
  const parentInput = new PassThrough();
  const childInput = new PassThrough();
  const parent = new BackendChannel('electron', parentInput, childInput);
  const child = new BackendChannel('bun', childInput, parentInput);
  const settings = new BackendBrowserSettings({ revision: 0, agent: true, subagent: true });
  const host: BunBrowserHost = {
    execute: mock(async () => ({ operation: 'browser.get_state' as const, text: 'fixture' })),
    collect: mock(async () => null),
    forget: mock(),
    revoke: mock(),
    restore: mock(),
    operation: mock(),
    reconnect: mock(),
  };
  const owner = new BunBrowserBridge(parent, settings.agent, settings.subagent, host);
  child.on('browser.settings', () => {});
  child.handle('browser.validate-owner', validateOwner);
  owner.activate();
  cleanup.push(() => {
    owner.dispose();
    parent.close();
    child.close();
  });
  return { parent, child, settings, host, owner };
}

const run = { agentId: 'worker', generation: 2, turnId: 5 };
const input = { sessionId: 'fixture', owner: run, controller: { run }, settingsRevision: 0 };

it('revalidates generation-bound owners before browser execution', async () => {
  const { child, host } = bridge();
  expect(await child.request('browser.run', input)).toMatchObject({ text: 'fixture' });
  expect(host.execute).toHaveBeenCalledTimes(1);
});

it('cancels in-flight browser work synchronously when a setting changes', async () => {
  const { child, settings, host } = bridge();
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  host.execute = mock(async (_input, signal) => {
    started();
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    return { operation: 'browser.get_state' as const, text: 'stale result' };
  });
  const result = child.request('browser.run', input).catch((error) => error);
  await running;
  settings.update({ revision: 1, agent: false, subagent: false });
  expect(await result).toBeInstanceOf(Error);
  expect(host.revoke).toHaveBeenCalledWith('fixture', run, true);
  const stale = await child.request('browser.run', input).catch((error) => error);
  expect(stale).toBeInstanceOf(Error);
  expect(host.execute).toHaveBeenCalledTimes(1);
});

it('propagates run revocation and channel failure without executing stale work', async () => {
  const { child, parent, host } = bridge();
  await child.emit('browser.revoke-run', { sessionId: 'fixture', run, settingChange: false });
  expect(host.revoke).toHaveBeenCalledWith('fixture', run, false);
  parent.close();
  const result = await child
    .request('browser.run', input, { timeoutMs: 25 })
    .catch((error) => error);
  expect(result).toBeInstanceOf(Error);
  expect(host.execute).not.toHaveBeenCalled();
});

it('does not revive an old agent generation when a late close arrives', () => {
  const registry = new BrowserSubagentRunRegistry(() => true);
  registry.attach('fixture', {
    agentId: 'worker',
    generation: 1,
    state: () => ({ running: true, turnId: 5, eligible: true }),
  });
  const first = registry.resolve('fixture', { ...run, generation: 1 });
  registry.attach('fixture', {
    agentId: 'worker',
    generation: 2,
    state: () => ({ running: true, turnId: 5, eligible: true }),
  });
  registry.closeAgent('fixture', 'worker', 1);
  expect(registry.resolve('fixture', run)).not.toBeNull();
  expect(() => first?.assertActive()).toThrow();
  expect(registry.resolve('fixture', { ...run, generation: 1 })).toBeNull();
});

it('refuses native execution when Bun rejects the current generation-bound owner', async () => {
  const { child, host } = bridge(() => false);
  expect(
    ((error: unknown) => () => {
      throw error;
    })(await rejectionOf(Promise.resolve(child.request('browser.run', input)))),
  ).toThrow('no longer active');
  expect(host.execute).not.toHaveBeenCalled();
});

it('discards an in-flight result after the backend revokes its exact run', async () => {
  const { child, host } = bridge();
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  host.execute = mock(async (_input, signal) => {
    started();
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    return { operation: 'browser.get_state' as const, text: 'late result' };
  });
  const result = child.request('browser.run', input);
  await running;
  await child.emit('browser.revoke-run', { sessionId: 'fixture', run, settingChange: false });
  expect(
    ((error: unknown) => () => {
      throw error;
    })(await rejectionOf(Promise.resolve(result))),
  ).toThrow('no longer current');
});
