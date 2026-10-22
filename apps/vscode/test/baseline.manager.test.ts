/**
 * Scenario: VSCode-owned file baselines for new, migrated, and forked sessions.
 * Responsibilities: capture originals, show changes, keep/undo, persist legacy tombstones, and reject unsafe paths.
 * Wiring: real temporary workspace/global-storage/legacy files; no stubbed collaborators.
 * Run: cd apps/vscode && bun run test -- baseline.manager.test.ts
 */
import { existsSync, writeFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

import { realNodeFs, realStatSync, statSyncMock } from './real-node-fs';
import { SYMLINKS } from './helpers';

// An unreachable UNC share reports EUNKNOWN on Windows rather than ENOENT, and
// `statSync` cannot be spied on through a module namespace. Only that export is
// replaced; every other `node:fs` export keeps its real implementation so the
// rest of the process is unaffected.
void mock.module('node:fs', () => ({
  ...realNodeFs,
  statSync: statSyncMock,
}));

import { BaselineManager, type BaselineSession } from '../src/managers/baseline.manager';

let root: string;
let workDir: string;
let storageRoot: string;
let manager: BaselineManager;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'vscode-baseline-'));
  workDir = join(root, 'workspace');
  storageRoot = join(root, 'global-storage');
  await mkdir(workDir, { recursive: true });
  manager = new BaselineManager(storageRoot);
});

afterEach(async () => {
  statSyncMock.mockReset();
  statSyncMock.mockImplementation(realStatSync);
  await rm(root, { recursive: true, force: true });
});

describe('file baselines (capture, compare, keep, and undo)', () => {
  it('keeps the first original when overlapping captures race', async () => {
    const session = createSession();
    const filePath = join(workDir, 'src', 'app.ts');
    await mkdir(join(workDir, 'src'), { recursive: true });
    writeFileSync(filePath, 'original\n', 'utf-8');

    const firstCapture = manager.capture(session, filePath);
    writeFileSync(filePath, 'after first edit\n', 'utf-8');
    const secondCapture = manager.capture(session, filePath);
    await Promise.all([firstCapture, secondCapture]);

    expect(await manager.getContent(session, filePath)).toBe('original\n');
  });

  it('returns the captured original after the manager is recreated', async () => {
    const session = createSession();
    const filePath = join(workDir, 'app.ts');
    await writeFile(filePath, 'persisted original\n', 'utf-8');
    await manager.capture(session, filePath);

    const reloadedManager = new BaselineManager(storageRoot);

    await expect(reloadedManager.getContent(session, filePath)).resolves.toBe(
      'persisted original\n',
    );
  });

  it('isolates the same session id between different Kimi homes', async () => {
    const session = createSession();
    const filePath = join(workDir, 'app.ts');
    const firstHome = new BaselineManager(storageRoot, join(root, 'home-a'));
    const secondHome = new BaselineManager(storageRoot, join(root, 'home-b'));
    await writeFile(filePath, 'home A original\n', 'utf-8');
    await firstHome.capture(session, filePath);
    await writeFile(filePath, 'home B original\n', 'utf-8');
    await secondHome.capture(session, filePath);

    await expect(firstHome.getContent(session, filePath)).resolves.toBe('home A original\n');
    await expect(secondHome.getContent(session, filePath)).resolves.toBe('home B original\n');
  });

  it('reports a modified file when current content differs from its original', async () => {
    const session = createSession();
    const filePath = join(workDir, 'app.ts');
    await writeFile(filePath, 'before\n', 'utf-8');
    await manager.capture(session, filePath);
    await writeFile(filePath, 'after\n', 'utf-8');

    await expect(manager.getChanges(session)).resolves.toEqual([
      { path: 'app.ts', status: 'Modified', additions: 1, deletions: 1 },
    ]);
  });

  it('reports an added file when it did not exist at capture time', async () => {
    const session = createSession();
    const filePath = join(workDir, 'new.ts');
    await manager.capture(session, filePath);
    await writeFile(filePath, 'new content\n', 'utf-8');

    await expect(manager.getChanges(session)).resolves.toEqual([
      { path: 'new.ts', status: 'Added', additions: 2, deletions: 0 },
    ]);
  });

  it('reports a deleted file when an existing original is removed', async () => {
    const session = createSession();
    const filePath = join(workDir, 'old.ts');
    await writeFile(filePath, 'line one\nline two', 'utf-8');
    await manager.capture(session, filePath);
    await unlink(filePath);

    await expect(manager.getChanges(session)).resolves.toEqual([
      { path: 'old.ts', status: 'Deleted', additions: 0, deletions: 2 },
    ]);
  });

  it('removes a newly created file when undo restores its missing original', async () => {
    const session = createSession();
    const filePath = join(workDir, 'new.ts');
    await manager.capture(session, filePath);
    await writeFile(filePath, 'created\n', 'utf-8');

    await manager.undo(session, filePath);

    expect(existsSync(filePath)).toBe(false);
  });

  it('restores an existing empty file without deleting it when undo runs', async () => {
    const session = createSession();
    const filePath = join(workDir, 'empty.ts');
    await writeFile(filePath, '', 'utf-8');
    await manager.capture(session, filePath);
    await writeFile(filePath, 'changed', 'utf-8');

    await manager.undo(session, filePath);

    expect(existsSync(filePath)).toBe(true);
    await expect(readFile(filePath, 'utf-8')).resolves.toBe('');
  });

  it('preserves CRLF bytes when undo restores the original file', async () => {
    const session = createSession();
    const filePath = join(workDir, 'windows.txt');
    await writeFile(filePath, 'first\r\nsecond\r\n', 'utf-8');
    await manager.capture(session, filePath);
    await writeFile(filePath, 'changed\n', 'utf-8');

    await manager.undo(session, filePath);

    await expect(readFile(filePath, 'utf-8')).resolves.toBe('first\r\nsecond\r\n');
  });

  // Windows has no POSIX permission bits: `chmod` is a no-op beyond the
  // read-only flag, so there is no mode to preserve.
  it.skipIf(process.platform === 'win32')('restores the original content and keeps the file mode when undo runs', async () => {
    const session = createSession();
    const filePath = join(workDir, 'script.sh');
    await writeFile(filePath, '#!/bin/sh\necho original\n', 'utf-8');
    await chmod(filePath, 0o600);
    await manager.capture(session, filePath);
    await manager.undo(session, filePath);

    await expect(readFile(filePath, 'utf-8')).resolves.toBe('#!/bin/sh\necho original\n');
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!SYMLINKS)('restores the snapshotted file behind an in-workspace symlink', async () => {
    const session = createSession();
    const target = join(workDir, 'target.txt');
    const link = join(workDir, 'link.txt');
    await writeFile(target, 'original\n', 'utf-8');
    await symlink(target, link);
    await manager.capture(session, link);
    await writeFile(target, 'changed\n', 'utf-8');

    await manager.undo(session, link);

    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    await expect(readFile(target, 'utf-8')).resolves.toBe('original\n');
  });

  it('leaves no temporary file behind when undo restores the original', async () => {
    const session = createSession();
    const filePath = join(workDir, 'app.ts');
    await writeFile(filePath, 'original\n', 'utf-8');
    await manager.capture(session, filePath);
    await writeFile(filePath, 'changed\n', 'utf-8');

    await manager.undo(session, filePath);

    await expect(readdir(workDir)).resolves.toEqual(['app.ts']);
  });

  it('recreates a file the session deleted after it was captured', async () => {
    const session = createSession();
    const filePath = join(workDir, 'src', 'app.ts');
    await mkdir(join(workDir, 'src'), { recursive: true });
    await writeFile(filePath, 'original\n', 'utf-8');
    await manager.capture(session, 'src/app.ts');
    await rm(join(workDir, 'src'), { recursive: true });

    await manager.undo(session, 'src/app.ts');

    await expect(readFile(filePath, 'utf-8')).resolves.toBe('original\n');
  });

  // Replacing a file while another handle holds it open is POSIX behaviour;
  // Windows refuses the rename with EPERM.
  it.skipIf(process.platform === 'win32')('replaces the restored file instead of truncating it in place', async () => {
    const session = createSession();
    const filePath = join(workDir, 'app.ts');
    await writeFile(filePath, 'original content\n', 'utf-8');
    await manager.capture(session, filePath);
    await writeFile(filePath, 'changed\n', 'utf-8');
    // A reader that opened the file before the restore: with `writeFile` it
    // would observe the truncated intermediate state, with a rename it keeps
    // reading the complete original.
    const heldOpen = await open(filePath, 'r');

    try {
      await manager.undo(session, filePath);

      await expect(readFile(filePath, 'utf-8')).resolves.toBe('original content\n');
      const handle = await heldOpen.readFile({ encoding: 'utf-8' });
      expect(handle).toBe('changed\n');
    } finally {
      await heldOpen.close();
    }
    await expect(readdir(workDir)).resolves.toEqual(['app.ts']);
  });

  it('captures a new original after keep accepts the previous changes', async () => {
    const session = createSession();
    const filePath = join(workDir, 'app.ts');
    await writeFile(filePath, 'first\n', 'utf-8');
    await manager.capture(session, filePath);
    await writeFile(filePath, 'accepted\n', 'utf-8');
    await manager.keep(session, filePath);

    await manager.capture(session, filePath);
    await writeFile(filePath, 'next edit\n', 'utf-8');

    expect(await manager.getContent(session, filePath)).toBe('accepted\n');
  });

  it('restores every tracked original when undo all runs', async () => {
    const session = createSession();
    await writeFile(join(workDir, 'one.ts'), 'one before', 'utf-8');
    await writeFile(join(workDir, 'two.ts'), 'two before', 'utf-8');
    await manager.capture(session, 'one.ts');
    await manager.capture(session, 'two.ts');
    await writeFile(join(workDir, 'one.ts'), 'one after', 'utf-8');
    await writeFile(join(workDir, 'two.ts'), 'two after', 'utf-8');

    await manager.undoAll(session);

    await expect(readFile(join(workDir, 'one.ts'), 'utf-8')).resolves.toBe('one before');
    await expect(readFile(join(workDir, 'two.ts'), 'utf-8')).resolves.toBe('two before');
  });

  it('refuses undo all when a tracked directory now links outside the workspace', async () => {
    const session = createSession();
    const trackedDir = join(workDir, 'src');
    const outsideDir = join(root, 'outside');
    await mkdir(trackedDir);
    await mkdir(outsideDir);
    await writeFile(join(trackedDir, 'app.ts'), 'original');
    await manager.capture(session, 'src/app.ts');
    await rm(trackedDir, { recursive: true });
    await writeFile(join(outsideDir, 'app.ts'), 'outside');
    await symlink(outsideDir, trackedDir, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(manager.undoAll(session)).rejects.toThrow('outside the session workspace');
    await expect(readFile(join(outsideDir, 'app.ts'), 'utf-8')).resolves.toBe('outside');
  });

  it('removes every visible change when keep all runs', async () => {
    const session = createSession();
    await writeFile(join(workDir, 'one.ts'), 'one before', 'utf-8');
    await writeFile(join(workDir, 'two.ts'), 'two before', 'utf-8');
    await manager.capture(session, 'one.ts');
    await manager.capture(session, 'two.ts');
    await writeFile(join(workDir, 'one.ts'), 'one after', 'utf-8');
    await writeFile(join(workDir, 'two.ts'), 'two after', 'utf-8');

    await manager.keepAll(session);

    await expect(manager.getChanges(session)).resolves.toEqual([]);
  });
});

describe('legacy baselines (fallback, tombstones, and fork isolation)', () => {
  it('returns the legacy original when no local baseline exists', async () => {
    const { session } = await createLegacySession('legacy original\n');
    await writeFile(join(workDir, 'app.ts'), 'current content\n', 'utf-8');

    await expect(manager.getContent(session, 'app.ts')).resolves.toBe('legacy original\n');
  });

  it('reports a legacy file when current content differs from its original', async () => {
    const { session } = await createLegacySession('legacy original\n');
    await writeFile(join(workDir, 'app.ts'), 'current content\n', 'utf-8');

    await expect(manager.getChanges(session)).resolves.toEqual([
      { path: 'app.ts', status: 'Modified', additions: 1, deletions: 1 },
    ]);
  });

  it('restores a legacy original without mutating its snapshot when undo runs', async () => {
    const { session, baselinePath } = await createLegacySession('legacy original\n');
    await writeFile(join(workDir, 'app.ts'), 'current content\n', 'utf-8');

    await manager.undo(session, 'app.ts');

    await expect(readFile(join(workDir, 'app.ts'), 'utf-8')).resolves.toBe('legacy original\n');
    await expect(readFile(baselinePath, 'utf-8')).resolves.toBe('legacy original\n');
  });

  it('persists a keep tombstone for legacy content without deleting the old snapshot', async () => {
    const { session, baselinePath } = await createLegacySession('legacy original\n');
    await writeFile(join(workDir, 'app.ts'), 'accepted content\n', 'utf-8');
    await manager.keep(session, 'app.ts');

    const reloadedManager = new BaselineManager(storageRoot);

    await expect(reloadedManager.getChanges(session)).resolves.toEqual([]);
    await expect(readFile(baselinePath, 'utf-8')).resolves.toBe('legacy original\n');
  });

  it('uses a materialized local original before the fork target legacy fallback', async () => {
    const source = createSession('ses-source');
    const filePath = join(workDir, 'app.ts');
    await writeFile(filePath, 'local original\n', 'utf-8');
    await manager.capture(source, filePath);
    const { session: target } = await createLegacySession('legacy original\n', 'ses-target');

    await manager.materializeToFork(source, target);

    await expect(manager.getContent(target, 'app.ts')).resolves.toBe('local original\n');
  });

  it('keeps a fork baseline readable when the legacy source is later deleted', async () => {
    const { session: source, legacySessionDir } = await createLegacySession(
      'legacy original\n',
      'ses-source',
    );
    const target = createSession('ses-target', source.metadata);
    await manager.materializeToFork(source, target);
    await rm(legacySessionDir, { recursive: true, force: true });

    await expect(manager.getContent(target, 'app.ts')).resolves.toBe('legacy original\n');
  });

  it('keeps the source baseline visible when the fork accepts its own copy', async () => {
    const { session: source } = await createLegacySession('legacy original\n', 'ses-source');
    const target = createSession('ses-target', source.metadata);
    await manager.materializeToFork(source, target);

    await manager.keep(target, 'app.ts');

    await expect(manager.getContent(source, 'app.ts')).resolves.toBe('legacy original\n');
  });

  it('preserves accepted legacy paths when a fork is materialized', async () => {
    const { session: source } = await createLegacySession('legacy original\n', 'ses-source');
    const target = createSession('ses-target', source.metadata);
    await manager.keep(source, 'app.ts');

    await manager.materializeToFork(source, target);

    await expect(manager.getContent(target, 'app.ts')).rejects.toThrow('No baseline exists');
  });
});

describe('baseline boundaries (errors, cleanup, and platform paths)', () => {
  it.skipIf(process.platform === 'win32')(
    'rejects an unreadable original without recording an empty baseline',
    async () => {
      const session = createSession();
      const filePath = join(workDir, 'unreadable.ts');
      await writeFile(filePath, 'original', 'utf-8');
      await chmod(filePath, 0o000);

      try {
        await expect(manager.capture(session, filePath)).rejects.toThrow(
          'Unable to capture original file',
        );
        await expect(manager.getContent(session, filePath)).rejects.toThrow('No baseline exists');
      } finally {
        await chmod(filePath, 0o600);
      }
    },
  );

  it('rejects a directory path without recording an empty baseline', async () => {
    const session = createSession();
    const directoryPath = join(workDir, 'not-a-file');
    await mkdir(directoryPath);

    await expect(manager.capture(session, directoryPath)).rejects.toThrow('is not a regular file');
    await expect(manager.getContent(session, directoryPath)).rejects.toThrow('No baseline exists');
  });

  it('throws a clear error when requested baseline content does not exist', async () => {
    await expect(manager.getContent(createSession(), 'missing.ts')).rejects.toThrow(
      'No baseline exists for "missing.ts"',
    );
  });

  it('rejects a relative path that escapes the workspace', async () => {
    await expect(manager.capture(createSession(), '../outside.ts')).rejects.toThrow(
      'is outside workspace',
    );
  });

  it('normalizes Windows drive case for an in-workspace baseline', async () => {
    const session: BaselineSession = { id: 'ses-windows', workDir: 'C:\\Workspace' };
    await manager.capture(session, 'C:\\Workspace\\src\\new.ts');

    await expect(manager.getContent(session, 'c:\\WORKSPACE\\SRC\\NEW.ts')).resolves.toBe('');
  });

  it('rejects a Windows path on another drive', async () => {
    const session: BaselineSession = { id: 'ses-windows', workDir: 'C:\\Workspace' };

    await expect(manager.capture(session, 'D:\\Workspace\\file.ts')).rejects.toThrow(
      'is outside workspace',
    );
  });

  it('normalizes case differences in an in-workspace UNC path', async () => {
    const session: BaselineSession = {
      id: 'ses-unc',
      workDir: '\\\\Server\\Share\\Workspace',
    };
    // An unreachable UNC share reports EUNKNOWN on Windows instead of ENOENT;
    // the manager only treats the file as new when the stat reports ENOENT.
    statSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOENT: no such file or directory, stat'), {
        code: 'ENOENT',
      });
    });
    await manager.capture(session, '\\\\server\\share\\workspace\\src\\new.ts');

    await expect(manager.getContent(session, 'src\\new.ts')).resolves.toBe('');
  });

  it('rejects a UNC path from another share', async () => {
    const session: BaselineSession = {
      id: 'ses-unc',
      workDir: '\\\\Server\\Share\\Workspace',
    };

    await expect(
      manager.capture(session, '\\\\Server\\OtherShare\\Workspace\\file.ts'),
    ).rejects.toThrow('is outside workspace');
  });

  it('removes persisted originals when the session baseline is deleted', async () => {
    const session = createSession();
    const filePath = join(workDir, 'app.ts');
    await writeFile(filePath, 'original', 'utf-8');
    await manager.capture(session, filePath);

    await manager.deleteSession(session.id);

    await expect(manager.getContent(session, filePath)).rejects.toThrow('No baseline exists');
  });
});

function createSession(
  id = 'ses-local',
  metadata?: Readonly<Record<string, unknown>>,
): BaselineSession {
  return { id, workDir, metadata };
}

async function createLegacySession(
  content: string,
  id = 'ses-legacy',
): Promise<{
  session: BaselineSession;
  legacySessionDir: string;
  baselinePath: string;
}> {
  const legacySessionDir = join(root, `legacy-${id}`);
  const baselinePath = join(legacySessionDir, 'baseline', 'app.ts');
  await mkdir(join(legacySessionDir, 'baseline'), { recursive: true });
  await writeFile(baselinePath, content, 'utf-8');
  return {
    session: createSession(id, { kimi_cli_source_path: legacySessionDir }),
    legacySessionDir,
    baselinePath,
  };
}
