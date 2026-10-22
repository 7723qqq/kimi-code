/**
 * `/feedback` attachment outcome: a codebase scan that hits its file-count cap
 * still uploads successfully, but the archive is only a prefix of the repo.
 * `submitFeedbackWithAttachments` must report that truncation separately from
 * the failure boolean so the caller can say so instead of implying "attached".
 *
 * Only the scanner's cap is pinned here (the scanner's own limit handling is
 * covered by `test/feedback/codebase-upload`); scan → package → upload all run
 * for real so the truncation has to travel the production path.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { setGlobal, restoreGlobals } from '#test/helpers/stubs';

import { submitFeedbackWithAttachments } from '#/feedback/feedback-attachments';
import { getFeedbackStatusCodebaseTruncated } from '#/tui/constant/feedback';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

import * as feedbackCodebase from '../../src/feedback/codebase';

// Spy on the real scanner instead of replacing the module: packaging and
// uploading still run for real, only the scan's file-count cap is tightened.
const originalScanCodebase = feedbackCodebase.scanCodebase;
spyOn(feedbackCodebase, 'scanCodebase').mockImplementation(
  (root: string, options: { signal?: AbortSignal } = {}) =>
    originalScanCodebase(root, { ...options, limits: { maxFiles: 2 } }),
);

afterEach(() => {
  restoreGlobals();
  mock.clearAllMocks();
});

/** A host whose session export and codebase packaging run for real; only the
 *  upload transport is stubbed. */
function makeHost(workDir: string): SlashCommandHost {
  const host = {
    state: {
      appState: {
        workDir,
        sessionId: 'ses_truncation',
        version: '1.0.0-test',
      },
    },
    harness: {
      listSessions: mock(async () => [
        {
          id: 'ses_truncation',
          sessionDir: workDir,
          workDir,
        },
      ]),
      exportSession: mock(async ({ outputPath }: { outputPath: string }) => {
        await writeFile(outputPath, 'session-bytes');
        return { zipPath: outputPath };
      }),
      auth: {
        createFeedbackUploadUrl: mock(
          async (input: { filename: string; size: number; sha256: string }) => ({
            kind: 'ok',
            uploadId: 1,
            parts: [
              {
                partNumber: 1,
                url: `https://example.test/${input.filename}`,
                method: 'PUT',
                size: input.size,
              },
            ],
          }),
        ),
        completeFeedbackUpload: mock(async () => ({ kind: 'ok' })),
      },
    },
  } as unknown as SlashCommandHost;

  setGlobal(
    'fetch',
    mock(async (_url: string, init: RequestInit) => {
      // Drain the part body so the archive's file handles are released.
      await new Response(init.body as ReadableStream).arrayBuffer();
      return new Response('', { status: 200, headers: { ETag: '"etag-1"' } });
    }),
  );

  return host;
}

describe('submitFeedbackWithAttachments truncation reporting', () => {
  it('reports the codebase scan cap without reporting an upload failure', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'feedback-truncated-'));
    try {
      await writeFile(join(workDir, 'a.ts'), 'export const a = 1;\n');
      await writeFile(join(workDir, 'b.ts'), 'export const b = 2;\n');
      await writeFile(join(workDir, 'c.ts'), 'export const c = 3;\n');
      const host = makeHost(workDir);

      const outcome = await submitFeedbackWithAttachments(host, 42, 'logs+codebase');

      expect(outcome.failed).toBe(false);
      expect(outcome.codebaseTruncated).toEqual({ reason: 'file-count', limit: 2 });
      expect(getFeedbackStatusCodebaseTruncated(outcome.codebaseTruncated!)).toContain('2 files');
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('reports no truncation when the scan stays under the cap', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'feedback-untruncated-'));
    try {
      await writeFile(join(workDir, 'a.ts'), 'export const a = 1;\n');
      const host = makeHost(workDir);

      const outcome = await submitFeedbackWithAttachments(host, 42, 'logs+codebase');

      expect(outcome.failed).toBe(false);
      expect(outcome.codebaseTruncated).toBeUndefined();
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
