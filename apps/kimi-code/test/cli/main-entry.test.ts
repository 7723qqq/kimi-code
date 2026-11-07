import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, it } from 'bun:test';

const appRoot = resolve(import.meta.dirname, '..', '..');
const repoRoot = resolve(appRoot, '..', '..');
const rawTextLoader = resolve(repoRoot, 'build', 'register-raw-text-loader.mjs');

it(
  'starts the CLI exactly once',
  { timeout: 120_000 },
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-main-entry-'));
    const tracePath = join(dir, 'startup-trace.log');
    try {
      spawnSync(
        process.execPath,
        [
          '--import',
          rawTextLoader,
          resolve(appRoot, 'src', 'main.ts'),
          '--prompt',
          'hi',
          '--model',
          'definitely-not-a-model',
        ],
        {
          cwd: appRoot,
          env: {
            ...process.env,
            KIMI_CODE_HOME: join(dir, 'home'),
            KIMI_STARTUP_TRACE: '1',
            KIMI_STARTUP_TRACE_LOG: tracePath,
          },
          encoding: 'utf-8',
        },
      );

      const trace = existsSync(tracePath) ? readFileSync(tracePath, 'utf-8') : '';
      const entries = trace.match(/ main:enter$/gm) ?? [];

      expect(entries).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
