#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';

// This script owns the e2e switches of a heavy run. `KIMI_E2E` is always on,
// which is what the offline e2e suites read. The real-LLM smoke additionally
// needs `KIMI_E2E_REAL=1` on this command: CI never sets it, so a heavy run
// stays offline, and that suite stays reachable either from here or from
// `bun run e2e:real` inside apps/kimi-code.
const realE2E = process.env['KIMI_E2E_REAL'] === '1';

const env = { ...process.env, KIMI_TEST_HEAVY: '1', KIMI_E2E: '1' };
if (realE2E) env['KIMI_E2E_REAL'] = '1';
else delete env['KIMI_E2E_REAL'];

const result = spawnSync('bun', ['scripts/run-tests.mjs', '--include-heavy'], {
  stdio: 'inherit',
  cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  env,
  shell: true,
});

process.exit(result.status ?? 1);
