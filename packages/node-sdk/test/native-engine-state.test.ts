import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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
