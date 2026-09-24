import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { nativeReadEngineState } from '@moonshot-ai/kimi-agent/native';

import { createKimiHarnessNative } from '#/index';

import { TEST_IDENTITY } from './test-identity';

/**
 * The host reads the engine's per-workspace state through this binding rather
 * than deriving the path itself: the store lives under
 * `<home>/.kimi-code/engine-state/<key>/state/`, where `<key>` is a digest of
 * the canonicalized workspace path. The host used to guess
 * `<sessionDir>/todo.json`, which nothing ever writes, so `/undo` always saw
 * an empty todo list.
 *
 * The read logic itself (resolving the workspace directory, and the
 * absent-domain / unknown-domain cases) is covered by the Rust test
 * `storage::state_store::tests::read_workspace_state_resolves_the_workspace_directory`.
 * What these pin is the binding being wired and answering `null` rather than
 * throwing when there is nothing to read.
 */
describe('nativeReadEngineState', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function workspace(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-engine-state-'));
    dirs.push(dir);
    return dir;
  }

  it('answers null for a workspace with no stored state', () => {
    expect(nativeReadEngineState(workspace(), 'todo')).toBeNull();
  });

  it('answers null for a domain the store does not own', () => {
    expect(nativeReadEngineState(workspace(), 'not-a-domain')).toBeNull();
  });

  it('answers null for a workspace that does not exist', () => {
    expect(nativeReadEngineState(join(workspace(), 'missing'), 'todo')).toBeNull();
  });
});

/**
 * The session warnings the engine derives from its MCP roster. The host used
 * to answer `[]` unconditionally, so a user whose MCP tools were missing got
 * no reason at all.
 */
describe('session warnings', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('answers an empty list for a session with no degraded MCP servers', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'kimi-warn-home-'));
    dirs.push(homeDir);
    const workDir = mkdtempSync(join(tmpdir(), 'kimi-warn-work-'));
    dirs.push(workDir);
    const harness = createKimiHarnessNative({ homeDir, identity: TEST_IDENTITY });
    const session = await harness.createSession({ workDir });
    await expect(session.getSessionWarnings()).resolves.toEqual([]);
  }, 60_000);
});

/**
 * `Session.getCronTasks` reads the workspace cron registry through the
 * engine. The registry is workspace-level state (the state-bridge `cron`
 * domain carries no session id), so the host asks the engine for it the same
 * way it reads the todo domain — the stub used to answer `[]`
 * unconditionally, which left a host polling for pending scheduled work
 * blind. The next-fire computation is the engine's (parser, timezone and
 * jitter); what these pin is the host reading the real registry and mapping
 * it onto the snapshot contract.
 */
describe('session getCronTasks', () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('reads the workspace cron registry through the engine', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'kimi-cron-home-'));
    dirs.push(homeDir);
    const workDir = mkdtempSync(join(tmpdir(), 'kimi-cron-work-'));
    dirs.push(workDir);
    // The engine-state store resolves under the process home, so pin it to
    // the temp home: a seeded registry must never touch the real profile.
    vi.stubEnv('HOME', homeDir);
    vi.stubEnv('USERPROFILE', homeDir);
    const harness = createKimiHarnessNative({ homeDir, identity: TEST_IDENTITY });
    const session = await harness.createSession({ workDir });

    // The first read resolves (and creates) the workspace state directory.
    await expect(session.getCronTasks()).resolves.toEqual({ tasks: [] });

    // Seed the registry the way the CronCreate tool does, then read again.
    // Identify the workspace dir by creation, not by count: a CI run may have
    // other engine state dirs under the same temp home (parallel harness
    // teardown races on shared runners), and the first `getCronTasks` call is
    // what materialized the dir this session actually reads.
    const stateRoot = join(homeDir, '.kimi-code', 'engine-state');
    const stateDirs = readdirSync(stateRoot)
      .map((name) => join(stateRoot, name))
      .filter((dir) => existsSync(join(dir, 'state')));
    if (stateDirs.length === 0) {
      throw new Error('no workspace state dir exists after the first cron read');
    }
    const workspaceDir = stateDirs.find((dir) =>
      existsSync(join(dir, 'state', 'cron.json')),
    );
    writeFileSync(
      join(
        workspaceDir ?? stateDirs[0]!,
        'state',
        'cron.json',
      ),
      JSON.stringify([
        {
          id: 'daily',
          cron: '0 9 * * *',
          prompt: 'hi',
          recurring: true,
          createdAt: Date.now(),
        },
      ]),
    );

    const { tasks } = await session.getCronTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe('daily');
    expect(tasks[0]!.cron).toBe('0 9 * * *');
    expect(tasks[0]!.recurring).toBe(true);
    expect(tasks[0]!.nextFireAt).not.toBeNull();
    expect(tasks[0]!.nextFireAt as number).toBeGreaterThan(Date.now() - 60_000);

    await session.close();
    await harness.close();
  }, 60_000);
});
