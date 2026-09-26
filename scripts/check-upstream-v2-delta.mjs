#!/usr/bin/env bun
/**
 * Ratchet gate for upstream behavior that lands in packages this fork deleted.
 *
 * The fork physically removed `packages/agent-core-v2`, `packages/kap-server`,
 * `packages/klient` and `packages/acp-server`: the Rust engine
 * (`packages/kimi-agent`) replaces them. Because those directories no longer
 * exist here, an upstream commit that changes them merges *silently* — nothing
 * conflicts, so nothing is ever ported. That is how 21 behavior commits piled up
 * unnoticed (see `packages/kimi-agent/ROADMAP.md` §6).
 *
 * This gate lists every commit that touched a retired package since the merge
 * base with the upstream ref and requires each one to be recorded in
 * `scripts/upstream-v2-delta-allowlist.json` with a deliberate verdict:
 *
 *   - `ported`          — the behavior now lives in the Rust engine.
 *   - `tracked`         — accepted debt, recorded as a roadmap work item.
 *   - `not-applicable`  — internal refactor/rename with no observable behavior.
 *   - `pending`         — not triaged yet; fails the gate.
 *
 * A commit missing from the allowlist also fails, so new upstream deltas cannot
 * be absorbed without a decision. Regenerate the entries (preserving recorded
 * verdicts, adding new commits as `pending`) with:
 *
 *   bun scripts/check-upstream-v2-delta.mjs --update
 *
 * The upstream ref is `upstream/main` by default; override with
 * `KIMI_UPSTREAM_REF=<ref>`. The gate fails loudly when the ref is unavailable
 * rather than passing silently — a missing reference is exactly the blindness
 * this check exists to remove.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ALLOWLIST = join(ROOT, 'scripts/upstream-v2-delta-allowlist.json');
const UPSTREAM_REF = process.env.KIMI_UPSTREAM_REF ?? 'upstream/main';
const RETIRED_PACKAGES = [
  'packages/agent-core-v2',
  'packages/kap-server',
  'packages/klient',
  'packages/acp-server',
];

const VERDICTS = new Set(['ported', 'tracked', 'not-applicable', 'pending']);

const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

/** Fail loudly when the upstream reference is missing. */
function resolveUpstreamRef() {
  try {
    return git('rev-parse', '--verify', '--quiet', `${UPSTREAM_REF}^{commit}`);
  } catch {
    console.error(
      `check-upstream-v2-delta: cannot resolve \`${UPSTREAM_REF}\`.\n` +
        '  Fetch it first (e.g. `git fetch upstream main`), or point\n' +
        '  KIMI_UPSTREAM_REF at the ref that tracks upstream. Refusing to pass\n' +
        '  without the reference: an unavailable upstream is indistinguishable\n' +
        '  from having no upstream deltas at all.',
    );
    process.exit(2);
  }
}

/** Commits touching a retired package since the fork's merge base. */
function collectDeltas() {
  const mergeBase = git('merge-base', 'HEAD', UPSTREAM_REF);
  const raw = git(
    'log',
    '--no-merges',
    '--date=short',
    '--format=%H%x1f%ad%x1f%s',
    `${mergeBase}..${UPSTREAM_REF}`,
    '--',
    ...RETIRED_PACKAGES,
  );
  if (raw === '') return { mergeBase, commits: [] };
  return {
    mergeBase,
    commits: raw.split('\n').map((line) => {
      const [sha, date, subject] = line.split('\u001F');
      return { sha, date, subject };
    }),
  };
}

function readAllowlist() {
  if (!existsSync(ALLOWLIST)) return { entries: [] };
  return JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
}

const DEFAULT_NOTE =
  'Verdicts for upstream commits touching packages this fork deleted. ' +
  'Regenerate with `bun scripts/check-upstream-v2-delta.mjs --update`; ' +
  'see scripts/upstream-v2-delta-allowlist.json for the verdict vocabulary.';

function writeAllowlist(entries, mergeBase, note) {
  const payload = {
    note: note ?? DEFAULT_NOTE,
    upstreamRef: UPSTREAM_REF,
    recordedMergeBase: mergeBase,
    recordedAt: new Date().toISOString().slice(0, 10),
    entries,
  };
  writeFileSync(ALLOWLIST, `${JSON.stringify(payload, null, 2)}\n`);
}

// Validate the upstream reference before touching history: a missing ref must
// fail loudly instead of looking like "upstream has no deltas".
resolveUpstreamRef();

// What the ref actually points at, plus its date. A *stale* local
// `refs/remotes/upstream/main` silently narrows the range and reports a green
// "all triaged" — that is how the 2.1.1 deltas were missed on 2026-09-24
// (packages/kimi-agent/ROADMAP.md §6.8). The commit date is the only offline
// signal a reviewer has for freshness, so it belongs in every run's output.
const refTip = git('log', '-1', '--date=short', '--format=%h %cs', UPSTREAM_REF);

const { mergeBase, commits } = collectDeltas();
const allowlist = readAllowlist();
const known = new Map(allowlist.entries.map((entry) => [entry.sha, entry]));

if (process.argv.includes('--update')) {
  const entries = commits.map((commit) => {
    const previous = known.get(commit.sha);
    return {
      sha: commit.sha,
      date: commit.date,
      subject: commit.subject,
      verdict: previous?.verdict ?? 'pending',
      ...(previous?.note === undefined ? {} : { note: previous.note }),
      ...(previous?.roadmap === undefined ? {} : { roadmap: previous.roadmap }),
    };
  });
  writeAllowlist(entries, mergeBase, allowlist.note);
  const pending = entries.filter((entry) => entry.verdict === 'pending').length;
  console.log(
    `check-upstream-v2-delta: recorded ${entries.length} delta(s) touching retired packages` +
      ` (${pending} pending).`,
  );
  process.exit(pending === 0 ? 0 : 1);
}

const problems = [];
for (const commit of commits) {
  const entry = known.get(commit.sha);
  if (entry === undefined) {
    problems.push({ commit, reason: 'not recorded in the allowlist' });
    continue;
  }
  if (!VERDICTS.has(entry.verdict)) {
    problems.push({ commit, reason: `unknown verdict \`${entry.verdict}\`` });
    continue;
  }
  if (entry.verdict === 'pending') {
    problems.push({ commit, reason: 'recorded, but still pending triage' });
  }
}

if (problems.length > 0) {
  console.error(
    `check-upstream-v2-delta: ${problems.length} unhandled upstream delta(s) in retired packages.\n` +
      `  merge base ${mergeBase.slice(0, 10)} .. ${UPSTREAM_REF} (ref tip ${refTip})\n`,
  );
  for (const { commit, reason } of problems) {
    console.error(`  ${commit.sha.slice(0, 10)} ${commit.date} ${commit.subject}\n      -> ${reason}`);
  }
  console.error(
    '\n  Port the behavior into packages/kimi-agent, or record the verdict in\n' +
      '  scripts/upstream-v2-delta-allowlist.json with a roadmap reference, then\n' +
      '  rerun `bun scripts/check-upstream-v2-delta.mjs --update`.',
  );
  process.exit(1);
}

const counts = new Map();
for (const commit of commits) {
  const verdict = known.get(commit.sha).verdict;
  counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
}
const summary = [...counts]
  .map(([verdict, count]) => `${String(verdict)}=${String(count)}`)
  .join(' | ');
console.log(
  `check-upstream-v2-delta: ${commits.length} delta(s) since ${mergeBase.slice(0, 10)} all triaged` +
    (summary === '' ? '' : ` (${summary})`),
);
console.log(`  upstream ref: ${UPSTREAM_REF} @ ${refTip}`);
if (commits.length === 0) {
  console.warn(
    '  WARNING: zero deltas is also exactly what a stale local ref looks like. Refresh it\n' +
      '           before trusting this line:\n' +
      '           git fetch upstream main:refs/remotes/upstream/main --force',
  );
}
