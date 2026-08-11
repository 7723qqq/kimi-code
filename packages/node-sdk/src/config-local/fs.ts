/**
 * Localized port of v1's `atomicWrite` (`agent-core/src/utils/fs.ts`): an
 * fsync'd write-then-rename so a crashed process never leaves a torn config
 * file behind.
 */
import { randomBytes } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { fsync } from 'node:fs';

function syncFd(fd: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    fsync(fd, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

export async function atomicWrite(
  filePath: string,
  content: string | Uint8Array,
): Promise<void> {
  const hex = randomBytes(4).toString('hex');
  const tmpPath = `${filePath}.tmp.${process.pid}.${hex}`;
  let renamed = false;
  try {
    const fh = await open(tmpPath, 'w');
    try {
      await fh.writeFile(content);
      await syncFd(fh.fd);
    } finally {
      await fh.close();
    }
    // Windows `fs.rename` maps to MoveFileEx and fails with EPERM if
    // the target is held by another handle. Pre-unlinking
    // before the rename turns this into the POSIX-style "replace" case.
    if (process.platform === 'win32') {
      try {
        await unlink(filePath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw error;
      }
    }
    await rename(tmpPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        await unlink(tmpPath);
      } catch {
        /* ignore — file may not exist if open itself failed */
      }
    }
  }
}
