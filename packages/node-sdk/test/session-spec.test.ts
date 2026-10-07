/**
 * Scenario: a spec started through the SDK is observable end to end — the
 * stage and progress file reach the public snapshot, and the stage reaches
 * session status.
 * Responsibilities: prove the pipeline, not the endpoints. Hand-built
 * SpecData or AppState objects are deliberately not used here, because that
 * is exactly the gap this suite closes.
 * Wiring: a real harness-backed session writes real files into the workspace.
 * Run: bunx vitest run packages/node-sdk/test/session-spec.test.ts
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

async function writeTestConfig(homeDir: string): Promise<void> {
  await writeFile(
    join(homeDir, 'config.toml'),
    `
default_model = "test-model"

[providers.local]
type = "openai"
base_url = "https://example.test/v1"
api_key = "sk-test"

[models.test-model]
provider = "local"
model = "test-model"
max_context_size = 200000
`,
    'utf-8',
  );
}

async function openSession(sessionId: string): Promise<{
  readonly session: Awaited<ReturnType<ReturnType<typeof createKimiHarness>['createSession']>>;
  readonly workDir: string;
}> {
  const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-spec-home-');
  const workDir = await makeTempDir(tempDirs, 'kimi-sdk-spec-work-');
  await writeTestConfig(homeDir);
  const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });
  const session = await harness.createSession({ id: sessionId, workDir });
  return { session, workDir };
}

describe('Spec mode through the SDK', () => {
  it('reports no spec and no stage when spec mode is off', async () => {
    const { session } = await openSession('ses_spec_off');

    await expect(session.getSpec()).resolves.toBeNull();
    await expect(session.getStatus()).resolves.toMatchObject({
      specMode: false,
      specStage: undefined,
    });
  });

  it('derives the stage from the documents that exist', async () => {
    const { session, workDir } = await openSession('ses_spec_stage');
    await session.setSpecMode(true);

    const spec = await session.getSpec();
    if (spec === null) throw new Error('expected an active spec');

    // Fresh spec: requirements is the first thing to write.
    await expect(session.getStatus()).resolves.toMatchObject({
      specMode: true,
      specStage: 'specify',
    });

    await writeFile(join(workDir, 'specs', spec.id, 'requirements.md'), '# Requirements');
    await expect(session.getSpec()).resolves.toMatchObject({ stage: 'plan' });
    await expect(session.getStatus()).resolves.toMatchObject({ specStage: 'plan' });

    await writeFile(join(workDir, 'specs', spec.id, 'design.md'), '# Design');
    await expect(session.getSpec()).resolves.toMatchObject({ stage: 'tasks' });
    await expect(session.getStatus()).resolves.toMatchObject({ specStage: 'tasks' });

    await writeFile(join(workDir, 'specs', spec.id, 'tasks.md'), '# Tasks');
    await expect(session.getSpec()).resolves.toMatchObject({
      stage: 'implement',
      complete: true,
    });
    await expect(session.getStatus()).resolves.toMatchObject({ specStage: 'implement' });
  });

  it('reports the progress file without letting it gate completion', async () => {
    const { session, workDir } = await openSession('ses_spec_progress');
    await session.setSpecMode(true);

    const spec = await session.getSpec();
    if (spec === null) throw new Error('expected an active spec');
    const dir = join(workDir, 'specs', spec.id);

    await expect(session.getSpec()).resolves.toMatchObject({ progress: '' });

    await writeFile(join(dir, 'progress.md'), '# Progress\n\n- aligned the docs');
    await expect(session.getSpec()).resolves.toMatchObject({
      progress: expect.stringContaining('aligned the docs') as unknown as string,
    });

    await writeFile(join(dir, 'requirements.md'), '# Requirements');
    await writeFile(join(dir, 'design.md'), '# Design');
    await writeFile(join(dir, 'tasks.md'), '# Tasks');

    // A written progress file changes neither the stage nor completeness.
    await expect(session.getSpec()).resolves.toMatchObject({
      stage: 'implement',
      complete: true,
    });
  });

  it('stops reporting a stage once spec mode is turned off', async () => {
    const { session } = await openSession('ses_spec_toggle');
    await session.setSpecMode(true);
    await expect(session.getStatus()).resolves.toMatchObject({ specMode: true });

    await session.setSpecMode(false);

    await expect(session.getStatus()).resolves.toMatchObject({ specMode: false });
    await expect(session.getSpec()).resolves.toBeNull();
  });

  it('evicts plan mode when spec mode is entered', async () => {
    const { session } = await openSession('ses_spec_evicts_plan');
    await session.setPlanMode(true);
    await expect(session.getStatus()).resolves.toMatchObject({ planMode: true, specMode: false });

    await session.setSpecMode(true);

    // The two are mutually exclusive: entering spec leaves plan behind rather
    // than stacking, so the write guards cannot intersect to deny everything.
    await expect(session.getStatus()).resolves.toMatchObject({ planMode: false, specMode: true });
  });

  it('evicts spec mode when plan mode is entered', async () => {
    const { session } = await openSession('ses_plan_evicts_spec');
    await session.setSpecMode(true);
    await expect(session.getStatus()).resolves.toMatchObject({ specMode: true, planMode: false });

    await session.setPlanMode(true);

    await expect(session.getStatus()).resolves.toMatchObject({ specMode: false, planMode: true });
    await expect(session.getSpec()).resolves.toBeNull();
  });
});
