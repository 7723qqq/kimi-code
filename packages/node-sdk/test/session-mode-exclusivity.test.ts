/**
 * End-to-end check for the D1 deadlock: entering spec mode from plan mode must
 * leave exactly one mode active, and the spec directory must actually be
 * writable afterwards. Before the fix, plan's guard and spec's guard combined
 * to deny every write, which is why this writes a real file rather than
 * asserting on the status flags alone.
 */

import { writeFile } from 'node:fs/promises';

import { join } from 'pathe';
import { afterEach, describe, expect, it } from 'vitest';

import { createKimiHarness } from '#/index';

import { makeTempDir, removeTempDirs } from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  await removeTempDirs(tempDirs);
});

async function openSession(sessionId: string): Promise<{
  readonly session: Awaited<ReturnType<ReturnType<typeof createKimiHarness>['createSession']>>;
  readonly workDir: string;
}> {
  const homeDir = await makeTempDir(tempDirs, 'kimi-e2e-modes-home-');
  const workDir = await makeTempDir(tempDirs, 'kimi-e2e-modes-work-');
  await writeFile(
    join(homeDir, 'config.toml'),
    [
      'default_model = "test-model"',
      '',
      '[providers.local]',
      'type = "openai"',
      'base_url = "https://example.test/v1"',
      'api_key = "sk-test"',
      '',
      '[models.test-model]',
      'provider = "local"',
      'model = "test-model"',
      'max_context_size = 200000',
    ].join('\n'),
    'utf-8',
  );
  const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
  const session = await harness.createSession({ id: sessionId, workDir });
  return { session, workDir };
}

describe('review modes end to end', () => {
  it('leaves plan mode when spec mode is entered, and the spec dir stays writable', async () => {
    const { session } = await openSession('ses_e2e_modes');
    await session.setPlanMode(true);
    await session.setSpecMode(true);

    // Exactly one mode: the two guards can no longer intersect to deny writes.
    const status = await session.getStatus();
    expect(status.specMode).toBe(true);
    expect(status.planMode).toBe(false);

    // The spec directory is reachable and a document lands in it.
    const spec = await session.getSpec();
    if (spec === null) throw new Error('expected an active spec');
    await writeFile(join(spec.dir, 'requirements.md'), '# Requirements\n\nReal content.');

    await expect(session.getSpec()).resolves.toMatchObject({ stage: 'plan' });
  });

  it('leaves spec mode when plan mode is entered', async () => {
    const { session } = await openSession('ses_e2e_modes_reverse');
    await session.setSpecMode(true);
    await session.setPlanMode(true);

    const status = await session.getStatus();
    expect(status.planMode).toBe(true);
    expect(status.specMode).toBe(false);
    await expect(session.getSpec()).resolves.toBeNull();
  });
});
