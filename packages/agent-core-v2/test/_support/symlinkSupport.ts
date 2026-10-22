import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const SYMLINKS = await (async (): Promise<boolean> => {
  const probe = await mkdtemp(join(tmpdir(), 'kimi-symlink-probe-'));
  try {
    await symlink(join(probe, 'a'), join(probe, 'b'));
    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
})();
