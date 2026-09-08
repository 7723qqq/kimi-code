/**
 * Scenario: Node SDK sessions persist and list through the public harness.
 * Responsibilities: workDir scoping and native path-safe listing.
 * Wiring: real in-process harness/session storage; no remote provider calls.
 * Run: bunx vitest run test/list-sessions.test.ts
 *
 * The former `SessionStore.list` suite (workDir bucket layout, session-index
 * file format, fork wire details, mtime sorting, legacy flat scanning) tested
 * the deleted v1 `agent-core` disk format; the v2 engine storage is
 * restructured, so those internals are no longer covered here.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKimiHarness, SDKRpcClientV2 } from '#/index';
import type { KimiError } from '#/index';

import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    // Windows: minidb/engine handles may outlive the test for a few hundred
    // ms; retry so a slow handle release does not leak the temp home.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kimi-sdk-list-'));
  tempDirs.push(dir);
  return dir;
}

describe('KimiHarness.listSessions', () => {
  it('rejects whitespace-only workDir with request.work_dir_required', async () => {
    const homeDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await expect(harness.listSessions({ workDir: '   ' })).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.work_dir_required',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('lists all sessions when no payload is provided', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const otherWorkDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await harness.createSession({ id: 'ses_harness_all_a', workDir });
      await harness.createSession({ id: 'ses_harness_all_b', workDir: otherWorkDir });

      const sessions = await harness.listSessions();
      expect(sessions.map((session) => session.id).toSorted()).toEqual([
        'ses_harness_all_a',
        'ses_harness_all_b',
      ]);
    } finally {
      await harness.close();
    }
  });

  it('lists a session from a workDir containing spaces and non-ASCII characters', async () => {
    const homeDir = await makeTempDir();
    const root = await makeTempDir();
    const workDir = join(root, 'Workspace With Spaces', '项目');
    await mkdir(workDir, { recursive: true });
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_unicode_workdir', workDir });

      const sessions = await harness.listSessions({ workDir });
      expect(sessions.map((item) => item.id)).toEqual([session.id]);
    } finally {
      await harness.close();
    }
  });

  it('resolves relative workDir inputs before filtering', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });
    const originalCwd = process.cwd();

    try {
      process.chdir(workDir);
      const session = await harness.createSession({ id: 'ses_relative_workdir', workDir: '.' });

      const sessions = await harness.listSessions({ workDir: '.' });
      expect(sessions.map((item) => item.id)).toEqual([session.id]);
    } finally {
      process.chdir(originalCwd);
      await harness.close();
    }
  });

  it('lists persisted sessions after the active Session has been closed', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      const session = await harness.createSession({ id: 'ses_closed_but_listed', workDir });
      await harness.closeSession(session.id);

      const sessions = await harness.listSessions({ workDir });
      expect(sessions.map((item) => item.id)).toEqual([session.id]);
    } finally {
      await harness.close();
    }
  });

  it('pages the full set with a keyset cursor', async () => {
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const harness = createKimiHarness({
      identity: TEST_IDENTITY,
      homeDir,
    });

    try {
      await harness.createSession({ id: 'ses_v1_page_a', workDir });
      await harness.createSession({ id: 'ses_v1_page_b', workDir });

      // The harness now backs onto the v2 engine, which pages by id keyset:
      // `limit: 1` returns a single item and a cursor pointing at it.
      const page = await harness.listSessionsPage({ workDir, limit: 1 });
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toBe(page.items[0]?.id);
    } finally {
      await harness.close();
    }
  });
});

describe('SDKRpcClientV2.listSessionsPage', () => {
  it('pages through the listing with keyset cursors', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const client = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });

    try {
      for (let i = 0; i < 5; i += 1) {
        const created = await client.createSession({ id: `ses_page_${i}`, workDir });
        await client.closeSession({ sessionId: created.id });
      }

      const page1 = await client.listSessionsPage({ workDir, limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).toBe(page1.items.at(-1)?.id);

      const page2 = await client.listSessionsPage({ workDir, limit: 2, before: page1.nextCursor });
      expect(page2.items).toHaveLength(2);
      expect(page2.nextCursor).toBe(page2.items.at(-1)?.id);

      const page3 = await client.listSessionsPage({ workDir, limit: 2, before: page2.nextCursor });
      expect(page3.items).toHaveLength(1);
      expect(page3.nextCursor).toBeUndefined();

      const pagedIds = [...page1.items, ...page2.items, ...page3.items].map((item) => item.id);
      expect(new Set(pagedIds)).toEqual(
        new Set([0, 1, 2, 3, 4].map((i) => `ses_page_${String(i)}`)),
      );
      // Draining pages yields exactly the unpaged listing, in the same order.
      const full = await client.listSessions({ workDir });
      expect(pagedIds).toEqual(full.map((item) => item.id));
    } finally {
      await client.close();
      vi.unstubAllEnvs();
    }
  });

  it('answers an empty terminal page for an unknown cursor', async () => {
    vi.stubEnv('KIMI_CODE_EXPERIMENTAL_FLAG', '0');
    const homeDir = await makeTempDir();
    const workDir = await makeTempDir();
    const client = new SDKRpcClientV2({ homeDir, identity: TEST_IDENTITY });

    try {
      const created = await client.createSession({ id: 'ses_cursor_probe', workDir });
      await client.closeSession({ sessionId: created.id });

      await expect(client.listSessionsPage({ workDir, before: 'ses_unknown' })).resolves.toEqual({
        items: [],
        nextCursor: undefined,
      });
    } finally {
      await client.close();
      vi.unstubAllEnvs();
    }
  });
});
