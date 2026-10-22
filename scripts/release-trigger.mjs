import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export default async function triggerRelease({
  env = process.env,
  execGh = (args, options) => execFileSync('gh', args, { encoding: 'utf8', ...options }),
  sleep = (ms) => setTimeout(ms),
  writeOutput = (line) => appendFileSync(env.GITHUB_OUTPUT, `${line}\n`),
  attempts = 18,
  intervalMs = 10_000,
} = {}) {
  const repo = env.GITHUB_REPOSITORY;
  const branch = env.GITHUB_REF_NAME;
  const sha = env.GITHUB_SHA;
  if (
    env.GITHUB_EVENT_NAME !== 'push' ||
    !branch?.startsWith('release/') ||
    env.GITHUB_REF !== `refs/heads/${branch}`
  ) {
    throw new Error('Automatic publication requires a release branch push');
  }
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('GITHUB_SHA must be a full commit SHA');
  const pages = JSON.parse(
    execGh(['api', `repos/${repo}/commits/${sha}/pulls?per_page=100`, '--paginate', '--slurp']),
  );
  const versionPR = pages
    .flat()
    .find(
      (pr) =>
        pr.merged_at &&
        pr.merge_commit_sha === sha &&
        pr.base.ref === branch &&
        pr.base.repo.full_name === repo &&
        pr.head.ref === `changeset-release/${branch}` &&
        pr.head.repo?.full_name === repo,
    );
  if (!versionPR) {
    writeOutput('publish=false');
    return;
  }
  const query = new URLSearchParams({ head_sha: sha, branch, event: 'push', per_page: '100' });
  let run;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = JSON.parse(
      execGh(['api', `repos/${repo}/actions/workflows/ci.yml/runs?${query}`]),
    );
    run = result.workflow_runs
      .filter(
        (item) => item.head_sha === sha && item.head_branch === branch && item.event === 'push',
      )
      .toSorted((a, b) => b.id - a.id)[0];
    if (run) break;
    await sleep(intervalMs);
  }
  if (!run) throw new Error('No push CI run found for the merged version commit');
  execGh(['run', 'watch', String(run.id), '--repo', repo, '--exit-status', '--interval', '10'], {
    stdio: 'inherit',
  });
  writeOutput('publish=true');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await triggerRelease();
}
