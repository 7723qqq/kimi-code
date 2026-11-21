import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const enforcesPosixFileModes = process.platform !== 'win32';
if (!enforcesPosixFileModes) {
  console.warn('[skip] POSIX file modes are not enforced on Windows');
}

function probeFileSymlink(): boolean {
  const probe = mkdtempSync(join(tmpdir(), 'symlink-probe-'));
  try {
    writeFileSync(join(probe, 'target.txt'), 'x');
    symlinkSync(join(probe, 'target.txt'), join(probe, 'link.txt'));
    return true;
  } catch {
    console.warn('[skip] file symlinks need Windows Developer Mode or elevation');
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

export const canCreateFileSymlink = probeFileSymlink();

export function linkDirectory(target: string, path: string): void {
  try {
    symlinkSync(target, path, 'dir');
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    symlinkSync(target, path, 'junction');
  }
}
