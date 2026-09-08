import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findKimiAgentAddon } from '@moonshot-ai/kimi-agent/session-handle';

import { createKimiHarnessNative, type KimiHarness } from '../src/index';

import { TEST_IDENTITY } from './test-identity';

// The native harness drives the Rust engine through the compiled napi addon, a
// gitignored build artifact. Skip the suite when it is absent rather than fail
// on `EngineSessionHandle.create` — a missing/stale addon must not masquerade as
// a harness regression.
const hasNativeAddon = findKimiAgentAddon() !== null;

describe.skipIf(!hasNativeAddon)('createKimiHarnessNative (Rust EngineSessionHandle backend)', () => {
  let homeDir: string;
  let harness: KimiHarness;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-sdk-native-test-'));
    // The harness asserts the host identity at construction (it seeds the
    // engine's client identity / request headers), like the v2 client did.
    harness = createKimiHarnessNative({
      homeDir,
      identity: TEST_IDENTITY,
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
    expect(session.workDir).toBe(homeDir.replaceAll('\\', '/'));

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

  it('fails loud on a prompt when no provider is configured (no fake reply)', async () => {
    const session = await harness.createSession({
      workDir: homeDir,
    });

    // This throwaway home has no [providers.*] and no [agent] nativeLlmProvider,
    // so the self-contained Rust engine has no model to call. The turn must
    // surface that loudly (the host llm_chat proxy throws) rather than end with
    // the canned "Hello! I am Kimi Code." the old stub returned, which looked
    // like a real answer. The submission resolves like v1/v2's; the failure
    // surfaces through the turn.ended event stream.
    const ended = waitForTurnEnded(session);
    await expect(session.prompt('Test prompt')).resolves.toBeUndefined();
    await expect(ended).resolves.toMatchObject({ reason: 'failed' });

    await session.close();
  });

  it('supports cancel on active or idle sessions', async () => {
    const session = await harness.createSession({
      workDir: homeDir,
    });

    await expect(session.cancel()).resolves.toBeUndefined();
    await session.close();
  });

  it('fails loud on steer when no provider is configured', async () => {
    const session = await harness.createSession({
      workDir: homeDir,
    });

    // steer on an idle session starts a turn, which hits the same missing-model
    // path as prompt: the submission resolves and the turn fails loudly through
    // the event stream rather than silently succeeding.
    const ended = waitForTurnEnded(session);
    await expect(session.steer('Steer instruction')).resolves.toBeUndefined();
    await expect(ended).resolves.toMatchObject({ reason: 'failed' });
    await session.close();
  }, 15_000);
});

function waitForTurnEnded(session: {
  onEvent(listener: (event: { readonly type: string; readonly reason?: string }) => void): () => void;
}): Promise<{ readonly reason?: string }> {
  return new Promise((resolve) => {
    const unsubscribe = session.onEvent((event) => {
      if (event.type === 'turn.ended') {
        unsubscribe();
        resolve(event);
      }
    });
  });
}
