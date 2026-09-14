import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createKimiHarnessNative } from '#/index';

import { TEST_IDENTITY } from './test-identity';

/**
 * `!` shell commands run through `runShellCommand`, which spawns a managed
 * bash process and awaits it. `cancelShellCommand` used to be a no-op that
 * returned void — success — so Esc/Ctrl-C left the command running while the
 * TUI reported it cancelled. The handle is now published under the caller's
 * `commandId` and the cancel kills the process tree.
 */
describe('native harness shell command cancellation', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function tempDir(tag: string): string {
    const dir = mkdtempSync(join(tmpdir(), `kimi-shell-${tag}-`));
    dirs.push(dir);
    return dir;
  }

  async function session(): Promise<Awaited<ReturnType<ReturnType<typeof createKimiHarnessNative>['createSession']>>> {
    const harness = createKimiHarnessNative({
      homeDir: tempDir('home'),
      identity: TEST_IDENTITY,
    });
    return harness.createSession({ workDir: tempDir('work') });
  }

  it('kills a running command instead of waiting it out', async () => {
    const s = await session();
    const started = Date.now();
    const running = s.runShellCommand('sleep 30', { commandId: 'cancel-me' });
    // Let the spawn register before cancelling; the handle is published
    // synchronously by `nativeBashSpawn`, so this is generous.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await s.cancelShellCommand('cancel-me');
    const result = await running;

    expect(Date.now() - started).toBeLessThan(20_000);
    expect(result.isError).toBe(true);
  }, 60_000);

  it('is a no-op for a command that already finished', async () => {
    const s = await session();
    const result = await s.runShellCommand('echo done', { commandId: 'already-done' });
    expect(result.stdout.trim()).toBe('done');
    // Nothing to kill is not an error, and must not throw.
    await expect(s.cancelShellCommand('already-done')).resolves.toBeUndefined();
  }, 60_000);

  it('is a no-op for a commandId it never saw', async () => {
    const s = await session();
    await expect(s.cancelShellCommand('never-started')).resolves.toBeUndefined();
  }, 60_000);
});
