import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export function toPosixPath(path) {
  return path.split('\\').join('/');
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function listFiles(root) {
  const files = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      // Symlinks satisfy neither isDirectory() nor isFile(); deliberately skipped.
      if (entry.isFile()) {
        files.push(path);
      }
    }
  }

  await walk(root);
  return files;
}
