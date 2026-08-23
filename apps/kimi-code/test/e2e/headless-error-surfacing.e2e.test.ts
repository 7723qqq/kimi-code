import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createKimiHarnessV2, type KimiHarness } from '@moonshot-ai/kimi-code-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createKimiCodeHostIdentity } from '#/cli/version';

const ENABLED = process.env['KIMI_E2E'] === '1';

let homeDir: string;
let workDir: string;
let oldHome: string | undefined;
let harness: KimiHarness | undefined;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'kimi-cli-prompt-home-'));
  workDir = await mkdtemp(join(tmpdir(), 'kimi-cli-prompt-work-'));
  oldHome = process.env['KIMI_CODE_HOME'];
  process.env['KIMI_CODE_HOME'] = homeDir;
});

afterEach(async () => {
  if (oldHome === undefined) {
    delete process.env['KIMI_CODE_HOME'];
  } else {
    process.env['KIMI_CODE_HOME'] = oldHome;
  }
  await harness?.close().catch(() => {});
  harness = undefined;
  await rm(homeDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

async function writeConfig(modelBody: string): Promise<void> {
  await writeFile(
    join(homeDir, 'config.toml'),
    `defaultProvider = "mock"\ndefaultModel = "mock-model"\n\n[providers.mock]\ntype = "openai"\nbase_url = "http://127.0.0.1:9/v1"\napi_key = "sk-mock"\n\n[models."mock-model"]\nprovider = "mock"\nmodel = "gpt-mock"\n${modelBody}\n`,
    'utf-8',
  );
}

describe.skipIf(!ENABLED)('headless prompt error surfacing e2e', () => {
  it('surfaces the real model configuration error instead of a teardown crash', async () => {
    await writeConfig('');
    harness = createKimiHarnessV2({
      homeDir,
      identity: createKimiCodeHostIdentity('0.0.0-e2e'),
    });
    const session = await harness.createSession({ workDir });

    const failure = await session.prompt('hi').then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toContain('max_context_size');
    expect(failure?.message).not.toContain('no active lifecycle context');
  }, 30_000);

  it('accepts a complete model config and reaches the provider endpoint', async () => {
    await writeConfig('max_context_size = 100000');
    harness = createKimiHarnessV2({
      homeDir,
      identity: createKimiCodeHostIdentity('0.0.0-e2e'),
    });
    const session = await harness.createSession({ workDir });

    const failure = await session.prompt('hi').then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(failure?.message ?? '').not.toContain('max_context_size');
    expect(failure?.message ?? '').not.toContain('no active lifecycle context');
  }, 30_000);
});
