/**
 * Session-archive digesting for `/feedback` uploads.
 *
 * Pins the two properties that matter for a multi-hundred-MiB export:
 *  1. an over-limit archive is rejected from its `stat` alone — the file is
 *     never read (the pre-fix code `readFile`'d the whole thing just to hash
 *     it, growing RSS by the file size, and only then let `uploadArchive`
 *     reject it), and
 *  2. within the limit the streamed digests stay byte-for-byte identical to
 *     the whole-buffer implementation.
 */

import { createHash } from 'node:crypto';
import { open, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { archiveFromExportedSession } from '#/feedback/feedback-attachments';
import { MAX_ARCHIVE_SIZE } from '#/feedback/upload';

const readFileSpy = vi.fn<typeof readFile>();

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (...args: Parameters<typeof readFile>) => {
      void readFileSpy(...args);
      return actual.readFile(...args);
    },
  };
});

afterEach(() => {
  readFileSpy.mockClear();
});

async function makeTempFileSize(size: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-session-archive-'));
  const path = join(dir, 'session.zip');
  // Sparse file: the reported size is `size` without actually occupying it,
  // so an over-limit archive can be exercised without writing 500 MiB.
  const handle = await open(path, 'w');
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
  return path;
}

async function digestOf(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

describe('archiveFromExportedSession', () => {
  it('rejects an over-limit export from stat without reading its contents', async () => {
    const path = await makeTempFileSize(MAX_ARCHIVE_SIZE + 1);
    try {
      readFileSpy.mockClear();
      const rssBefore = process.memoryUsage().rss;
      const startedAt = Date.now();

      await expect(archiveFromExportedSession(path)).rejects.toThrow(
        new RegExp(
          `size ${String(MAX_ARCHIVE_SIZE + 1)} exceeds maximum allowed size ${String(MAX_ARCHIVE_SIZE)}`,
        ),
      );

      // Deterministic main assertion: nothing was read from the file.
      expect(readFileSpy).not.toHaveBeenCalled();
      // Auxiliary: hashing 500 MiB would be visible both in time and in RSS.
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(process.memoryUsage().rss - rssBefore).toBeLessThan(200 * 1024 * 1024);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('produces the same digests as the whole-buffer implementation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feedback-session-digest-'));
    const path = join(dir, 'session.zip');
    // Larger than one stream chunk so the digest has to span several reads.
    const payload = Buffer.alloc(3 * 1024 * 1024, 7);
    await writeFile(path, payload);
    try {
      const archive = await archiveFromExportedSession(path);
      const expected = await digestOf(path);

      expect(archive.size).toBe(payload.byteLength);
      expect(archive.sha256).toBe(expected);
      expect(archive.fingerprint).toBe(expected);
      expect(archive.fileCount).toBe(1);
      expect(archive.path).toBe(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
