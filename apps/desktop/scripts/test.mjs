#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const desktopDir = resolve(import.meta.dirname, '..');
const preload = resolve(desktopDir, '../../scripts/test/bun-vitest-compat.ts');
const bun = process.execPath;
const args = process.argv.slice(2);

const has = (name) => args.includes(name) || args.some((arg) => arg.startsWith(`${name}=`));
const value = (name) => {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  const next = index === -1 ? undefined : args[index + 1];
  return next !== undefined && !next.startsWith('--') ? next : undefined;
};

const watch = has('--watch');
const coverage = has('--coverage');
const coverageDir = value('--coverage-dir');
const reporter = value('--coverage-reporter');
const shard = value('--shard');
const timeout = value('--timeout') ?? '30000';
const parallel = value('--parallel') ?? '8';
const retry = value('--retry');
const namePattern = value('--test-name-pattern');
const randomize = has('--randomize');
const bailValue = (() => {
  const raw = value('--bail');
  return raw !== undefined && /^\d+$/.test(raw) ? raw : undefined;
})();
const bail = has('--bail');
const timings = value('--timings');
const ignorePatterns = args.filter((arg) => arg.startsWith('--path-ignore-patterns='));

const uiFiles = [
  ...new Bun.Glob('tests/web/**/*.test.ts').scanSync({ cwd: desktopDir }),
  ...new Bun.Glob('tests/renderer/**/*.test.ts').scanSync({ cwd: desktopDir }),
];
const vitestOnlyFiles = [];
const bunFiles = [];
for (const file of uiFiles) {
  const text = await Bun.file(resolve(desktopDir, file)).text();
  const vitestOnly =
    text.includes('vi.hoisted') ||
    text.includes('vi.resetModules') ||
    text.includes('vi.useFakeTimers') ||
    text.includes('vi.advanceTimersByTime') ||
    /import[^;]*\bassert\b[^;]*from 'vitest'/.test(text);
  (vitestOnly ? vitestOnlyFiles : bunFiles).push(file);
}

const bunArgs = ['test', '--preload', preload, `--parallel=${parallel}`, '--max-concurrency=1'];
if (shard !== undefined) bunArgs.push(`--shard=${shard}`);
bunArgs.push(`--timeout=${timeout}`);
if (retry !== undefined) bunArgs.push(`--retry=${retry}`);
if (bailValue !== undefined) bunArgs.push(`--bail=${bailValue}`);
else if (bail) bunArgs.push('--bail');
if (namePattern !== undefined) bunArgs.push(`--test-name-pattern=${namePattern}`);
if (randomize) bunArgs.push('--randomize');
if (coverage) {
  bunArgs.push('--coverage');
  if (reporter !== undefined) bunArgs.push(`--coverage-reporter=${reporter}`);
  if (coverageDir !== undefined) bunArgs.push(`--coverage-dir=${resolve(desktopDir, coverageDir)}`);
}
if (timings !== undefined) bunArgs.push(`--timings=${timings}`);
for (const pattern of ignorePatterns) bunArgs.push(pattern);
if (watch) bunArgs.push('--watch');
bunArgs.push(...bunFiles);

const vitestArgs = ['--bun', 'vitest', watch ? '--watch' : 'run', '--configLoader', 'native'];
if (shard !== undefined) vitestArgs.push(`--shard=${shard}`);
vitestArgs.push('--testTimeout', timeout);
vitestArgs.push('--maxWorkers', parallel);
if (retry !== undefined) vitestArgs.push('--retry', retry);
if (bailValue !== undefined) vitestArgs.push('--bail', bailValue);
else if (bail) vitestArgs.push('--bail', '1');
if (namePattern !== undefined) vitestArgs.push('--testNamePattern', namePattern);
if (randomize) vitestArgs.push('--sequence.shuffle');
if (coverage) {
  vitestArgs.push('--coverage');
  if (reporter !== undefined) vitestArgs.push(`--coverage.reporter=${reporter}`);
  const dir = coverageDir === undefined ? 'coverage/vitest' : `${coverageDir}/vitest`;
  vitestArgs.push(`--coverage.reportsDirectory=${resolve(desktopDir, dir)}`);
}
if (shard !== undefined) vitestArgs.push('--passWithNoTests');
vitestArgs.push(...vitestOnlyFiles, 'tests/main', 'src');

if (timings !== undefined) {
  console.warn('desktop: --timings covers the Bun web/renderer group only');
}
if (coverage) {
  console.warn('desktop: coverage is written per runner; merge the two lcov reports if needed');
}

if (!watch) {
  console.log('desktop: web/renderer -> Bun compatibility preload');
  const bunResult = spawnSync(bun, bunArgs, { cwd: desktopDir, stdio: 'inherit' });
  console.log('desktop: main/src -> Bun Vitest');
  const vitestResult = spawnSync(bun, vitestArgs, { cwd: desktopDir, stdio: 'inherit' });
  const failed = (bunResult.status ?? 1) !== 0 || (vitestResult.status ?? 1) !== 0;
  process.exit(failed ? 1 : 0);
}

const children = [
  spawn(bun, bunArgs, { cwd: desktopDir, stdio: 'inherit' }),
  spawn(bun, vitestArgs, { cwd: desktopDir, stdio: 'inherit' }),
];
const stop = (signal) => {
  for (const child of children) child.kill(signal);
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
let remaining = children.length;
let failed = false;
for (const child of children) {
  child.on('exit', (code) => {
    if (code !== 0) failed = true;
    remaining -= 1;
    if (remaining === 0) process.exit(failed ? 1 : 0);
  });
}
