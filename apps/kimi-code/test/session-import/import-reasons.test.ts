import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, mock } from 'bun:test';

import type { ImportCandidate } from '#/session-import/run-import';

const NOW = Date.now();
const roots: string[] = [];

afterEach(async () => {
  mock.restore();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<{ project: string; kimiHome: string }> {
  const root = await mkdtemp(join(tmpdir(), 'import-reasons-'));
  roots.push(root);
  const project = join(root, 'project');
  await mkdir(project);
  return { project, kimiHome: join(root, 'kimi') };
}

it('turns unreliable conversions into skip reasons and failures', async () => {
  const { project, kimiHome } = await setup();
  const actualSessionImport = await import('@moonshot-ai/session-import');
  void mock.module('@moonshot-ai/session-import', () => ({
    ...actualSessionImport,
    convertSession: async ({ sourcePath }: { sourcePath: string }) => {
      const code = sourcePath.slice(sourcePath.lastIndexOf('/') + 1, -'.jsonl'.length);
      return { status: 'unreliable', error: { code, message: `${code} message` }, issues: [] };
    },
  }));
  const { importSessions } = await import('#/session-import/run-import');
  const candidates: ImportCandidate[] = ['SOURCE_CHANGED', 'EMPTY_SOURCE_HISTORY', 'UNSUPPORTED_HISTORY_BASE', 'CONVERSION_FAILED'].map((code) => ({
    source: 'claude-code' as const,
    path: `/example/${code}.jsonl`,
    sourceId: code,
    cwd: project,
    modifiedAt: NOW,
    sessionId: `ses_${code}`,
  }));
  expect(await importSessions(candidates, { kimiHome, contextWindow: 32_768, tokenBudget: 16_384, now: NOW })).toEqual({
    imported: [],
    alreadyImported: 0,
    missingFolder: 0,
    inUse: 1,
    empty: 1,
    unsupported: 1,
    failed: [{ path: '/example/CONVERSION_FAILED.jsonl', message: 'CONVERSION_FAILED message' }],
    stopped: false,
  });
  expect(await readdir(join(kimiHome, 'sessions')).catch(() => [])).toEqual([]);
});
