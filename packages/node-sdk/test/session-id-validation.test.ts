import { existsSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKimiHarness, type KimiError } from '#/index';

import { TEST_IDENTITY } from './test-identity';

// Spy on `node:fs` so the delete test can make the recursive removal fail
// without needing a real undeletable directory.
vi.mock('node:fs', { spy: true });

// Every RPC that turns a client-supplied session id into a path segment —
// create, resume, rename, delete, export — must reject an id that could
// escape the sessions root before any filesystem call. deleteSession is the
// destructive case: it removes the resolved directory recursively.
//
// The list covers each escape class the guard names: separators, `.`/`..`
// (including the all-dots `...` that exact matching misses), drive-relative
// and NTFS-stream `:`, the Win32 trailing-dot/space aliases (`.. ` still
// resolves to `..` after normalization), and invisible control characters.
const ESCAPING_IDS = [
  '../outside',
  '..',
  '.',
  '...',
  '.. ',
  'evil.',
  'a/b',
  'a\\b',
  'C:evil',
  'a:b',
  'a\u0001b',
  'a\tb',
] as const;

const tempDirs: string[] = [];

async function removeDirWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  await rm(dir, { recursive: true, force: true });
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await removeDirWithRetry(dir);
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-session-id-'));
  tempDirs.push(dir);
  return dir;
}

describe('session id path-segment validation', () => {
  it('createSession rejects ids that are not a single path segment', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    for (const id of ESCAPING_IDS) {
      // createSession forwards the id verbatim: the error echoes exactly
      // what the caller sent (`.. ` keeps its space).
      await expect(harness.createSession({ id, workDir })).rejects.toMatchObject({
        code: 'session.id_invalid',
        details: { sessionId: id },
      } satisfies Partial<KimiError>);
    }
  });

  it('createSession still accepts a legitimate custom id', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    const session = await harness.createSession({ id: 'custom.session-1', workDir });

    expect(session.id).toBe('custom.session-1');
  });

  // The guard is a blacklist on purpose: a non-ASCII id is a valid directory
  // name on every supported platform, and rejecting it would strand any
  // existing session created under one (unresumable and undeletable).
  it('createSession still accepts a non-ASCII id', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    const session = await harness.createSession({ id: '会话-一', workDir });

    expect(session.id).toBe('会话-一');
  });

  it('resumeSession rejects ids that are not a single path segment', async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    for (const id of ESCAPING_IDS) {
      // resumeSession trims on entry (normalizeSessionId), so the guard sees
      // and reports the trimmed id (`.. ` -> `..`).
      await expect(harness.resumeSession({ id })).rejects.toMatchObject({
        code: 'session.id_invalid',
        details: { sessionId: id.trim() },
      } satisfies Partial<KimiError>);
    }
  });

  it('renameSession rejects ids that are not a single path segment', async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    for (const id of ESCAPING_IDS) {
      await expect(harness.renameSession({ id, title: 'x' })).rejects.toMatchObject({
        code: 'session.id_invalid',
        details: { sessionId: id },
      } satisfies Partial<KimiError>);
    }
  });

  it('deleteSession rejects escaping ids and leaves the target directory intact', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
    // A directory outside the sessions root that looks like a session, so the
    // not-found check would pass and the recursive delete would fire if the
    // id were joined into the path unchecked.
    const outside = join(workDir, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'session-meta.json'), '{}', 'utf-8');
    await writeFile(join(outside, 'keep.txt'), 'keep', 'utf-8');

    await expect(harness.deleteSession('../outside')).rejects.toMatchObject({
      code: 'session.id_invalid',
      details: { sessionId: '../outside' },
    } satisfies Partial<KimiError>);

    expect(await readFile(join(outside, 'keep.txt'), 'utf-8')).toBe('keep');
  });

  // deleteSession's rmSync is the only thing that removes the session from
  // disk, and listSessions enumerates the sessions root from disk — so a
  // swallowed failure tells the caller the delete succeeded while the session
  // reappears in the picker on the next list. The TUI already reports a
  // rejection here ("Failed to delete session …").
  it('deleteSession reports a failed directory removal instead of claiming success', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
    const session = await harness.createSession({ id: 'delete-failure-1', workDir });
    const sessionDir = join(homeDir, 'sessions', session.id);
    expect(existsSync(sessionDir)).toBe(true);

    vi.mocked(rmSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('EPERM: operation not permitted, rmdir'), { code: 'EPERM' });
    });
    await expect(harness.deleteSession(session.id)).rejects.toThrow(/EPERM/);
    expect(existsSync(sessionDir)).toBe(true);

    // The retry finds the session on disk again and removes it for real.
    await harness.deleteSession(session.id);
    expect(existsSync(sessionDir)).toBe(false);
  });
});
