import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let cached: boolean | undefined;

export function supportsSymlinks(): boolean {
  if (cached !== undefined) return cached;
  const dir = mkdtempSync(join(tmpdir(), 'symlink-probe-'));
  try {
    writeFileSync(join(dir, 'target'), '');
    symlinkSync(join(dir, 'target'), join(dir, 'link'));
    cached = true;
  } catch {
    cached = false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return cached;
}
