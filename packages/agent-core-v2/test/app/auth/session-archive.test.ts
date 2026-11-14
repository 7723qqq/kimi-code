import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { open, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { archiveFromExportedSession } from '#/app/auth/feedbackService';
import { MAX_ARCHIVE_SIZE } from '#/app/auth/feedback/upload';

const readStreamSpy = spyOn(nodeFs, 'createReadStream');

afterEach(() => {
  readStreamSpy.mockClear();
});

async function makeTempFileSize(size: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-session-archive-'));
  const path = join(dir, 'session.zip');
  const handle = await open(path, 'w');
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
  return path;
}

async function digestOf(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

describe('archiveFromExportedSession', () => {
  it('rejects an over-limit export from stat without reading its contents', async () => {
    const path = await makeTempFileSize(MAX_ARCHIVE_SIZE + 1);
    try {
      readStreamSpy.mockClear();
      const rssBefore = process.memoryUsage().rss;
      const startedAt = Date.now();

      await expect(archiveFromExportedSession(path)).rejects.toThrow(
        new RegExp(
          `size ${String(MAX_ARCHIVE_SIZE + 1)} exceeds maximum allowed size ${String(MAX_ARCHIVE_SIZE)}`,
        ),
      );

      expect(readStreamSpy).not.toHaveBeenCalled();
      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(process.memoryUsage().rss - rssBefore).toBeLessThan(200 * 1024 * 1024);
    } finally {
      await rm(join(path, '..'), { recursive: true, force: true });
    }
  });

  it('produces the same digests as the whole-buffer implementation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feedback-session-digest-'));
    const path = join(dir, 'session.zip');
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
