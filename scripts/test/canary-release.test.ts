import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

import {
  buildCanaryRecord,
  compareCanaryVersions,
  computeCanaryBaseVersion,
  computeCanaryVersion,
  findNewerCanaryVersion,
  isCompleteCanaryRelease,
  listSuccessfulMainCiShas,
  PACKAGE_NAME,
  parseCanaryVersion,
  readCanaryRelease,
  readNpmCanaryVersion,
  requiredCanaryReleaseAssets,
  resolveCanaryBaseVersion,
  selectCanaryCommit,
} from '../canary-release.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const CANARY = '2.3.3-canary.20261028012345-0123456';

test('canary versions combine the package base, UTC publish time, and short commit', () => {
  const input = { baseVersion: '2.3.3', publishedAt: '2026-10-28T01:23:45Z', sha: SHA };
  expect(computeCanaryVersion(input)).toBe(CANARY);
  expect(computeCanaryVersion({ ...input, publishedAt: '2026-10-28T09:23:45+08:00' })).toBe(CANARY);
  expect(() => computeCanaryVersion({ ...input, baseVersion: '2.4.0-beta.0' })).toThrow(
    /plain x\.y\.z/,
  );
  expect(() => computeCanaryVersion({ ...input, publishedAt: 'not-a-date' })).toThrow(
    /publishedAt/,
  );
  expect(() => computeCanaryVersion({ ...input, sha: '0123456' })).toThrow(/full commit sha/);
});

test('canary base uses the CLI newVersion from the release plan', () => {
  for (const [type, newVersion] of [
    ['patch', '2.4.1'],
    ['minor', '2.5.0'],
    ['major', '3.0.0'],
  ]) {
    const releasePlan = {
      releases: [{ name: PACKAGE_NAME, type, newVersion, changesets: ['cli-change'] }],
    };
    expect(computeCanaryBaseVersion({ releasePlan, packageVersion: '2.4.0' })).toBe(newVersion);
  }
  const dependencyPlan = {
    releases: [{ name: PACKAGE_NAME, type: 'patch', newVersion: '2.4.1', changesets: [] }],
  };
  expect(computeCanaryBaseVersion({ releasePlan: dependencyPlan, packageVersion: '2.4.0' })).toBe(
    '2.4.1',
  );
});

test('canary base increments patch only when the release plan has no CLI release', () => {
  for (const releases of [
    [],
    [{ name: '@example/other', type: 'major', newVersion: '2.0.0', changesets: ['other-change'] }],
  ]) {
    expect(computeCanaryBaseVersion({ releasePlan: { releases }, packageVersion: '2.4.0' })).toBe(
      '2.4.1',
    );
  }
});

test('canary base rejects malformed release plans and non-plain versions', () => {
  for (const releasePlan of [
    {},
    { releases: [{}] },
    { releases: [{ name: PACKAGE_NAME, newVersion: '2.5.0-next.0' }] },
  ]) {
    expect(() => computeCanaryBaseVersion({ releasePlan, packageVersion: '2.4.0' })).toThrow();
  }
});

test('changeset status provides the canary base from its output file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-base-test-'));
  const outputFile = join(dir, 'release-plan.json');
  let invocation;
  const baseVersion = resolveCanaryBaseVersion({
    outputFile,
    packageVersion: '2.4.0',
    execute(command, args, options) {
      invocation = { command, args, options };
      writeFileSync(
        outputFile,
        JSON.stringify({
          releases: [{ name: PACKAGE_NAME, newVersion: '2.4.1', changesets: [] }],
        }),
      );
    },
  });
  expect(baseVersion).toBe('2.4.1');
  expect(invocation).toEqual({
    command: 'bun',
    args: ['run', 'changeset', 'status', '--output', outputFile],
    options: { stdio: 'inherit' },
  });
  rmSync(dir, { recursive: true, force: true });
});

test('changeset status failures do not fall back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'canary-base-test-'));
  expect(() =>
    resolveCanaryBaseVersion({
      outputFile: join(dir, 'failed.json'),
      packageVersion: '2.4.0',
      execute() {
        throw new Error('status failed');
      },
    }),
  ).toThrow(/status failed/);
  expect(() =>
    resolveCanaryBaseVersion({
      outputFile: join(dir, 'missing.json'),
      packageVersion: '2.4.0',
      execute() {},
    }),
  ).toThrow(/ENOENT/);
  const damagedFile = join(dir, 'damaged.json');
  writeFileSync(damagedFile, '{');
  expect(() =>
    resolveCanaryBaseVersion({
      outputFile: damagedFile,
      packageVersion: '2.4.0',
      execute() {},
    }),
  ).toThrow(SyntaxError);
  rmSync(dir, { recursive: true, force: true });
});

test('canary version parsing accepts only a plain base, a 14-digit time, and a 7-hex commit', () => {
  expect(parseCanaryVersion(CANARY)).toEqual({
    base: [2, 3, 3],
    timestamp: '20261028012345',
    commit: '0123456',
  });
  for (const bad of [
    '2.3.3',
    '0.0.0-dev.42',
    '2.3.3-canary.20261028012345.g0123456',
    '2.3.3-canary.2026102801234-0123456',
    '2.3.3-canary.20261028012345-012345',
    '2.3.3-canary.20261028012345-ABCDEF0',
    '2.3.3-canary.20261028012345-0123456.1',
    '02.3.3-canary.20261028012345-0123456',
    '2.4.0-beta.0-canary.20261028012345-0123456',
  ]) {
    expect(parseCanaryVersion(bad)).toBeNull();
  }
});

test('canary ordering compares the base numerically, then the publish time, then the commit', () => {
  expect(
    compareCanaryVersions(
      '2.3.3-canary.20261028000000-0000000',
      '2.3.3-canary.20261027235959-fffffff',
    ) > 0,
  ).toBe(true);
  expect(
    compareCanaryVersions(
      '2.3.4-canary.20200101000000-0000000',
      '2.3.3-canary.20991231235959-fffffff',
    ) > 0,
  ).toBe(true);
  expect(
    compareCanaryVersions(
      '2.10.0-canary.20261028000000-0000000',
      '2.9.0-canary.20261028000000-0000000',
    ) > 0,
  ).toBe(true);
  expect(compareCanaryVersions(CANARY, CANARY)).toBe(0);
  expect(() => compareCanaryVersions('0.0.0-dev.42', CANARY)).toThrow(/not canary versions/);
});

test('canary record contains only the client channel pointer fields', () => {
  const input = { version: CANARY, publishedAt: '2026-10-28T01:23:45Z' };
  expect(buildCanaryRecord(input)).toEqual({
    schemaVersion: 1,
    version: CANARY,
    publishedAt: '2026-10-28T01:23:45Z',
    rollout: [],
  });
  expect(() => buildCanaryRecord({ ...input, version: '2.4.0' })).toThrow(/invalid canary version/);
  expect(() => buildCanaryRecord({ ...input, publishedAt: 'not-a-date' })).toThrow(/publishedAt/);
});

test('a complete canary release contains the pointer and every native artifact', () => {
  const names = requiredCanaryReleaseAssets();
  expect(names.length).toBe(38);
  const release = { isDraft: false, assets: names.map((name) => ({ name })) };
  expect(isCompleteCanaryRelease(release)).toBe(true);
  expect(isCompleteCanaryRelease({ ...release, isDraft: true })).toBe(false);
  expect(
    isCompleteCanaryRelease({
      ...release,
      assets: release.assets.filter((asset) => asset.name !== 'canary.json'),
    }),
  ).toBe(false);
  expect(
    isCompleteCanaryRelease({
      ...release,
      assets: release.assets.filter((asset) => asset.name !== 'kimi-code-linux-x64.zst'),
    }),
  ).toBe(false);
});

test('release lookup tolerates only a missing release and propagates other failures', () => {
  const release = { isDraft: false, assets: [] };
  expect(readCanaryRelease('tag', () => release)).toEqual(release);
  expect(
    readCanaryRelease('missing', () => {
      throw new Error('HTTP 404: Not Found');
    }),
  ).toBeNull();
  expect(
    readCanaryRelease('missing', () => {
      throw new Error('release not found');
    }),
  ).toBeNull();
  expect(() =>
    readCanaryRelease('tag', () => {
      throw new Error('rate limited');
    }),
  ).toThrow(/rate limited/);
  expect(() =>
    readCanaryRelease('tag', () => {
      throw new SyntaxError('Unexpected token');
    }),
  ).toThrow(/Unexpected token/);
});

test('canary release accepts only the latest main commit with successful CI', () => {
  const input = { ref: 'refs/heads/main', sha: 'c', greenShas: ['a', 'b'], canaryReleases: [] };
  expect(() => selectCanaryCommit(input)).toThrow(/latest main commit c has not passed CI/);
  expect(selectCanaryCommit({ ...input, greenShas: ['a', 'b', 'c'] })).toEqual({
    sha: 'c',
    skip: false,
    reason: '',
  });
  expect(() => selectCanaryCommit({ ...input, ref: 'refs/heads/release/2.4', greenShas: ['c'] })).toThrow(
    /only from main/,
  );
});

test('CI selection asks gh to return only successful main head SHAs', () => {
  let invocation;
  const shas = listSuccessfulMainCiShas('MoonshotAI/kimi-code', (command, args, options) => {
    invocation = { command, args, options };
    return 'a\n\nb\n';
  });
  expect(shas).toEqual(['a', 'b']);
  expect(invocation.command).toBe('gh');
  expect(invocation.args[1]).toBe(
    'repos/MoonshotAI/kimi-code/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=100',
  );
  expect(invocation.args.slice(2)).toEqual(['--jq', '.workflow_runs[].head_sha']);
  expect(invocation.options).toEqual({ encoding: 'utf8' });
});

test('a new task skips a complete release but resumes a partial release', () => {
  const input = {
    ref: 'refs/heads/main',
    sha: 'c',
    greenShas: ['c'],
    canaryReleases: [{ tag: `@moonshot-ai/kimi-code@${CANARY}`, isComplete: true }],
  };
  expect(selectCanaryCommit(input)).toEqual({
    sha: 'c',
    skip: true,
    reason: `c already has @moonshot-ai/kimi-code@${CANARY}`,
  });
  expect(
    selectCanaryCommit({
      ...input,
      canaryReleases: [{ tag: `@moonshot-ai/kimi-code@${CANARY}`, isComplete: false }],
    }),
  ).toEqual({
    sha: 'c',
    skip: false,
    reason: '',
  });
});

test('an older canary run is stale after a newer run publishes', () => {
  const older = '2.3.3-canary.20261027012345-fffffff';
  const newer = '2.3.3-canary.20261029012345-0000000';
  expect(findNewerCanaryVersion(CANARY, [older, newer])).toBe(newer);
  expect(findNewerCanaryVersion(CANARY, [older, CANARY])).toBeNull();
});

test('npm canary lookup stays enabled for stale-publish protection', () => {
  let invocation;
  const version = readNpmCanaryVersion((command, args, options) => {
    invocation = { command, args, options };
    return `${CANARY}\n`;
  });
  expect(version).toBe(CANARY);
  expect(invocation).toEqual({
    command: 'npm',
    args: ['view', PACKAGE_NAME, 'dist-tags.canary'],
    options: { encoding: 'utf8' },
  });
  expect(readNpmCanaryVersion(() => '')).toBe('');
  expect(() => readNpmCanaryVersion(() => '2.4.0')).toThrow(/npm canary tag is malformed/);
});
