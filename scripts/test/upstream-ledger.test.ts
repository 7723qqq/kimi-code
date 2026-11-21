import { afterEach, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const HEADER =
  'pr\tsha\ttitle\tcluster\tverdict\tprobe\tevidence\tbatch_done\tapproved_by\tupdated\tfiles';
const fixtures: string[] = [];

function run(cwd: string, command: string[]) {
  const result = Bun.spawnSync(command, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function git(cwd: string, ...args: string[]): string {
  const result = run(cwd, ['git', ...args]);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function commit(cwd: string, file: string, body: string): string {
  writeFileSync(join(cwd, file), body);
  git(cwd, 'add', '--', file);
  git(cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', body);
  return git(cwd, 'rev-parse', 'HEAD');
}

function fixture() {
  mkdirSync(join(ROOT, '.tmp'), { recursive: true });
  const cwd = mkdtempSync(join(ROOT, '.tmp/upstream-ledger-test-'));
  fixtures.push(cwd);
  mkdirSync(join(cwd, 'scripts'));
  mkdirSync(join(cwd, '.upstream'));
  copyFileSync(join(ROOT, 'scripts/upstream-ledger.mjs'), join(cwd, 'scripts/upstream-ledger.mjs'));
  git(cwd, 'init', '-q', '-b', 'main');
  const base = commit(cwd, 'base.txt', 'base');
  git(cwd, 'switch', '-qc', 'target');
  const target = commit(cwd, 'target.txt', 'target');
  git(cwd, 'tag', 'release-2.7.0');
  git(cwd, 'switch', '-qc', 'outside', 'main');
  const outside = commit(cwd, 'outside.txt', 'outside');
  git(cwd, 'switch', '-q', 'main');
  const ledger = join(cwd, '.upstream/ledger.tsv');
  writeFileSync(ledger, `${HEADER}\n`);
  const invoke = (...args: string[]) =>
    run(cwd, [process.execPath, 'scripts/upstream-ledger.mjs', ...args]);
  const row = (sha: string, verdict = 'equivalent', probe = 'grep:base@base.txt') =>
    ['1', sha, sha, 'B1', verdict, probe, 'original evidence', 'no', '-', '2026-01-01', '1'].join(
      '\t',
    );
  return { cwd, ledger, base, target, outside, invoke, row };
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

for (const selector of ['tag', 'sha']) {
  test(`refresh pins a ${selector} without fetching upstream and is idempotent`, () => {
    const f = fixture();
    const ref = selector === 'tag' ? 'release-2.7.0' : f.target;
    const first = f.invoke('--refresh', '--ref', ref);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('1 new rows');
    const text = readFileSync(f.ledger, 'utf8');
    expect(text).toContain(f.target);
    expect(text).not.toContain(f.outside);
    expect(f.invoke('--refresh', '--ref', ref).code).toBe(0);
    expect(readFileSync(f.ledger, 'utf8')).toBe(text);
    expect(git(f.cwd, 'remote')).toBe('');
  });
}

test('refresh retains existing verdicts and evidence on a diverged history', () => {
  const f = fixture();
  const before = `${HEADER}\n${f.row(f.target)}\n${f.row(f.outside, 'partial')}\n`;
  writeFileSync(f.ledger, before);
  const result = f.invoke('--refresh', '--ref', 'release-2.7.0');
  expect(result.code).toBe(0);
  const lines = readFileSync(f.ledger, 'utf8').split('\n');
  expect(lines).toContain(f.row(f.target));
  expect(lines).toContain(f.row(f.outside, 'partial'));
  expect(result.stdout).toContain('0 new rows');
});

for (const args of [
  ['--refresh', '--ref', 'missing-release'],
  ['--refresh', '--ref'],
  ['--verify', '--ref', '--batch', 'B1'],
  ['--report', '--ref', 'base.txt'],
]) {
  test(`rejects an invalid ref without writing the ledger: ${args.join(' ')}`, () => {
    const f = fixture();
    const before = readFileSync(f.ledger, 'utf8');
    const result = f.invoke(...args);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('ref');
    expect(readFileSync(f.ledger, 'utf8')).toBe(before);
  });
}

test('verify leaves unreachable rows unchanged and report excludes them', () => {
  const f = fixture();
  const outside = f.row(f.outside, 'partial', 'grep:not-found@base.txt');
  writeFileSync(f.ledger, `${HEADER}\n${f.row(f.target, 'pending')}\n${outside}\n`);
  const verified = f.invoke('--verify', '--ref', 'release-2.7.0', '--batch', 'B1');
  expect(verified.code).toBe(0);
  expect(verified.stdout).toContain('verify: 1 pass, 0 fail');
  expect(readFileSync(f.ledger, 'utf8').split('\n')).toContain(outside);
  const report = f.invoke('--report', '--ref', f.target);
  expect(report.code).toBe(0);
  expect(report.stdout).toContain('total\t1\tclosed=1\tremaining=0');
});
