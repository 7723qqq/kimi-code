import { expect } from 'bun:test';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Windows only allows creating symlinks in developer mode, so tests that need
// a real link are gated on this probe instead of on the platform.
export const SYMLINKS: boolean = await (async () => {
  const probe = await mkdtemp(join(tmpdir(), 'kimi-vscode-symlink-probe-'));
  try {
    await symlink(join(probe, 'a'), join(probe, 'b'));
    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
})();

export async function waitFor(
  probe: () => void | Promise<void>,
  options: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const timeout = options.timeout ?? 1_000;
  const interval = options.interval ?? 10;
  const deadline = Date.now() + timeout;
  let lastError: unknown;
  for (;;) {
    try {
      await probe();
      return;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) throw lastError;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, interval);
    });
  }
}

export { expect };
