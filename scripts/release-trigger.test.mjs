import { test } from 'bun:test';
import assert from 'node:assert/strict';

import triggerRelease from './release-trigger.mjs';

const sha = 'a'.repeat(40);
const branch = 'release/test';
const repo = 'example/project';
const pr = {
  merged_at: '2026-10-14T00:00:00Z',
  merge_commit_sha: sha,
  base: { ref: branch, repo: { full_name: repo } },
  head: { ref: `changeset-release/${branch}`, repo: { full_name: repo } },
};
const env = {
  GITHUB_EVENT_NAME: 'push',
  GITHUB_REPOSITORY: repo,
  GITHUB_REF_NAME: branch,
  GITHUB_REF: `refs/heads/${branch}`,
  GITHUB_SHA: sha,
};
const runs = {
  workflow_runs: [
    { id: 7, head_sha: sha, head_branch: branch, event: 'push' },
    { id: 8, head_sha: 'b'.repeat(40), head_branch: branch, event: 'push' },
    { id: 9, head_sha: sha, head_branch: branch, event: 'pull_request' },
  ],
};

function run(overrides = {}, envOverrides = {}) {
  const state = { pulls: [pr], watchStatus: 0, apiError: false, emptyRunPolls: 0, ...overrides };
  const calls = [];
  const lines = [];
  const sleeps = [];
  const result = triggerRelease({
    env: { ...env, ...envOverrides },
    execGh(args) {
      calls.push(args);
      if (state.apiError) throw new Error(`gh ${args.join(' ')} failed`);
      if (args[0] === 'run') {
        if (state.watchStatus !== 0)
          throw new Error(`gh run watch exited with ${state.watchStatus}`);
        return '';
      }
      if (args[1].includes('/pulls?')) return JSON.stringify([state.pulls]);
      if (args[1].includes('/actions/workflows/ci.yml/runs?')) {
        if (state.emptyRunPolls > 0) {
          state.emptyRunPolls--;
          return JSON.stringify({ workflow_runs: [] });
        }
        return JSON.stringify(runs);
      }
      throw new Error(`unexpected gh invocation: ${args.join(' ')}`);
    },
    sleep(ms) {
      sleeps.push(ms);
      return Promise.resolve();
    },
    writeOutput(line) {
      lines.push(line);
    },
  });
  return { result, calls, sleeps, output: () => lines.map((line) => `${line}\n`).join('') };
}

await test('merged version PR waits for its push CI, not newer or PR runs', async () => {
  const { result, output, calls } = run();
  await result;
  assert.equal(output(), 'publish=true\n');
  assert.deepEqual(calls.at(-1), [
    'run',
    'watch',
    '7',
    '--repo',
    repo,
    '--exit-status',
    '--interval',
    '10',
  ]);
});

await test('ordinary pushes, unmerged PRs, other branches and forks do not publish', async () => {
  for (const pulls of [
    [],
    [{ ...pr, merged_at: null }],
    [{ ...pr, merge_commit_sha: 'b'.repeat(40) }],
    [{ ...pr, base: { ...pr.base, ref: 'release/other' } }],
    [{ ...pr, head: { ...pr.head, ref: 'fix/bug' } }],
    [{ ...pr, head: { ...pr.head, repo: { full_name: 'fork/project' } } }],
    [{ ...pr, head: { ...pr.head, repo: null } }],
  ]) {
    const { result, output, calls } = run({ pulls });
    await result;
    assert.equal(output(), 'publish=false\n');
    assert.equal(calls.length, 1);
  }
});

await test('failed or cancelled CI and API failures never authorize publishing', async () => {
  for (const state of [{ watchStatus: 1 }, { watchStatus: 2 }, { apiError: true }]) {
    const { result, output } = run(state);
    await assert.rejects(result);
    assert.equal(output(), '');
  }
});

await test('manual runs, main and invalid SHA cannot authorize publishing', async () => {
  for (const envOverrides of [
    { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { GITHUB_REF_NAME: 'main', GITHUB_REF: 'refs/heads/main' },
    { GITHUB_SHA: 'abc' },
  ]) {
    const { result, output, calls } = run({}, envOverrides);
    await assert.rejects(result);
    assert.equal(calls.length, 0);
    assert.equal(output(), '');
  }
});

await test('polls until the push CI run appears and fails once the attempts run out', async () => {
  const found = run({ emptyRunPolls: 2 });
  await found.result;
  assert.deepEqual(found.sleeps, [10_000, 10_000]);
  assert.equal(found.output(), 'publish=true\n');

  const missing = run({ emptyRunPolls: 18 });
  await assert.rejects(missing.result, /No push CI run found/);
  assert.equal(missing.sleeps.length, 18);
  assert.equal(missing.output(), '');
});
