import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createKimiHarnessNative, type KimiHarness } from '../src/index';

describe('createKimiHarnessNative (Rust EngineSessionHandle backend)', () => {
  let homeDir: string;
  let harness: KimiHarness;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-sdk-native-test-'));
    harness = createKimiHarnessNative({
      homeDir,
    });
  });

  afterEach(async () => {
    await harness.close();
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('creates and lists sessions via native EngineSessionHandle', async () => {
    const session = await harness.createSession({
      workDir: homeDir,
    });

    expect(session.id).toBeDefined();
    expect(session.workDir).toBe(homeDir);

    const summaries = await harness.listSessions();
    expect(summaries.some((s) => s.id === session.id)).toBe(true);

    await session.close();
    expect(session.isClosed).toBe(true);
  });

  it('subscribes to session events cleanly', async () => {
    const session = await harness.createSession({
      workDir: homeDir,
    });

    const receivedEvents: unknown[] = [];
    const unsub = session.onEvent((event) => {
      receivedEvents.push(event);
    });

    expect(typeof unsub).toBe('function');
    unsub();
    await session.close();
  });

  it('enqueues a prompt and receives turn events from EngineSessionHandle', async () => {
    const session = await harness.createSession({
      workDir: homeDir,
    });

    const receivedEvents: Array<{ type: string }> = [];
    session.onEvent((event) => {
      receivedEvents.push(event as { type: string });
    });

    await session.prompt('Test prompt');
    expect(receivedEvents.some((e) => e.type === 'turn.started')).toBe(true);
    expect(receivedEvents.some((e) => e.type === 'turn.ended')).toBe(true);

    await session.close();
  });

  it('supports cancel on active or idle sessions', async () => {
    const session = await harness.createSession({
      workDir: homeDir,
    });

    await expect(session.cancel()).resolves.toBeUndefined();
    await session.close();
  });

  it('supports steer on active sessions', async () => {
    const session = await harness.createSession({
      workDir: homeDir,
    });

    await expect(session.steer('Steer instruction')).resolves.toBeUndefined();
    await session.close();
  });
});
