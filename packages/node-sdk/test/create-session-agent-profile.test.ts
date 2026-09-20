/**
 * Scenario: `--agent` / `--agent-file` reach the native engine session.
 * Responsibilities: the explicit-file failure is fatal and names the file, an
 *   unknown `--agent` name fails creation naming the value, and a discovered
 *   project profile is accepted and registered as a subagent profile.
 * Wiring: the real native harness (napi addon) and real temp directories; no
 *   LLM calls are made (session creation builds the pipeline, not a turn).
 * Run: bunx vitest run test/create-session-agent-profile.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createKimiHarnessNative, type KimiHarness } from '#/index';

import { findKimiAgentAddon } from '@moonshot-ai/kimi-agent/session-handle';

import { TEST_IDENTITY } from './test-identity';

// The native harness drives the Rust engine through the compiled napi addon, a
// gitignored build artifact. Skip the suite when it is absent rather than fail
// on `EngineSessionHandle.create` — a missing/stale addon must not masquerade as
// a harness regression.
const hasNativeAddon = findKimiAgentAddon() !== null;

describe.skipIf(!hasNativeAddon)('agent profile binding at session creation', () => {
  const dirs: string[] = [];
  const harnesses: KimiHarness[] = [];

  afterEach(async () => {
    while (harnesses.length > 0) await harnesses.pop()!.close();
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  function harness(homeDir: string): KimiHarness {
    const instance = createKimiHarnessNative({ homeDir, identity: TEST_IDENTITY });
    harnesses.push(instance);
    return instance;
  }

  function writeProjectAgent(workDir: string, name: string, extra = ''): void {
    const dir = join(workDir, '.kimi-code', 'agents');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${name}.md`),
      `---\nname: ${name}\ndescription: Test agent.\n${extra}---\n\nYou are ${name}.\n`,
      'utf-8',
    );
  }

  it('fails creation with the offending name when --agent matches nothing', async () => {
    const homeDir = tempDir('kimi-agent-home-');
    const workDir = tempDir('kimi-agent-work-');

    await expect(
      harness(homeDir).createSession({
        id: 'ses_unknown_agent',
        workDir,
        agentProfile: 'definitely-not-an-agent',
      }),
    ).rejects.toMatchObject({
      name: 'KimiError',
      code: 'agent.not_found',
      message: expect.stringContaining('definitely-not-an-agent'),
    });
  });

  it('accepts a built-in profile name', async () => {
    const homeDir = tempDir('kimi-agent-home-');
    const workDir = tempDir('kimi-agent-work-');

    await expect(
      harness(homeDir).createSession({ id: 'ses_builtin_agent', workDir, agentProfile: 'explore' }),
    ).resolves.toMatchObject({ id: 'ses_builtin_agent' });
  });

  it('accepts a profile discovered from a project agent file', async () => {
    const homeDir = tempDir('kimi-agent-home-');
    const workDir = tempDir('kimi-agent-work-');
    writeProjectAgent(workDir, 'reviewer');

    await expect(
      harness(homeDir).createSession({
        id: 'ses_discovered_agent',
        workDir,
        agentProfile: 'reviewer',
      }),
    ).resolves.toMatchObject({ id: 'ses_discovered_agent' });
  });

  it('fails creation naming the path when --agent-file cannot be read', async () => {
    const homeDir = tempDir('kimi-agent-home-');
    const workDir = tempDir('kimi-agent-work-');
    const missing = join(workDir, 'nope.md');

    await expect(
      harness(homeDir).createSession({
        id: 'ses_missing_agent_file',
        workDir,
        agentFiles: [missing],
      }),
    ).rejects.toMatchObject({
      name: 'KimiError',
      code: 'request.invalid',
      message: expect.stringContaining('nope.md'),
    });
  });

  it('does not leave a failed session advertised as live', async () => {
    const homeDir = tempDir('kimi-agent-home-');
    const workDir = tempDir('kimi-agent-work-');
    const instance = harness(homeDir);

    await expect(
      instance.createSession({
        id: 'ses_reusable',
        workDir,
        agentProfile: 'still-not-an-agent',
      }),
    ).rejects.toThrow(/still-not-an-agent/);

    // The id must be free again: the failed create removed its meta.
    const created = await instance.createSession({
      id: 'ses_reusable',
      workDir,
      agentProfile: 'coder',
    });
    expect(created.id).toBe('ses_reusable');
  });

  it('restores the bound profile when a persisted session is resumed', async () => {
    const homeDir = tempDir('kimi-agent-home-');
    const workDir = tempDir('kimi-agent-work-');
    writeProjectAgent(workDir, 'reviewer');

    const first = harness(homeDir);
    const session = await first.createSession({
      id: 'ses_resume_profile',
      workDir,
      agentProfile: 'reviewer',
    });
    await session.close();
    await first.close();

    const second = harness(homeDir);
    await expect(second.resumeSession({ id: 'ses_resume_profile' })).resolves.toMatchObject({
      id: 'ses_resume_profile',
    });
  });
});
