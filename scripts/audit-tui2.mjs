#!/usr/bin/env node
/**
 * Audit the tui2 module end-to-end against the polished-state baseline.
 *
 * Run before pushing any tui2/* change, or as a sanity loop after any
 * edit batch. Exits non-zero on any red, prints the red banner.
 *
 * Skips commands that take too long:
 *   - `oxlint --type-aware` is run on apps/kimi-code only (not the full tree)
 *   - root typecheck is gated behind `pnpm run build:packages` and is
 *     intentionally out of scope (this audit is the per-edit loop, the
 *     release pipeline re-runs the full matrix)
 *
 * Override the bun/vitest path by setting $AUDIT_BUN / $AUDIT_VITEST
 * (default: `bun --bun ./node_modules/.bin/vitest` for both).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');

const RED = '\x1B[31m';
const GREEN = '\x1B[32m';
const YELLOW = '\x1B[33m';
const RESET = '\x1B[0m';

const BUN = process.env.AUDIT_BUN ?? 'bun';
const VITEST_BIN = process.env.AUDIT_VITEST ?? join(REPO_ROOT, 'node_modules', '.bin', 'vitest');

/** Run a command, returning { ok, stdout, stderr }. */
function run(cmd, args, { cwd = REPO_ROOT } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
    cmd: `${cmd} ${args.join(' ')}`,
  };
}

const checks = [];

/** Register a check; the runner handles pass/fail reporting. */
function check(name, fn) {
  checks.push({ name, fn });
}

check('branch / version', () => {
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch.ok) throw new Error(branch.stderr || branch.stdout);
  const branchName = branch.stdout.trim();
  const pkgPath = join(REPO_ROOT, 'apps', 'kimi-code', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  if (branchName !== 'tui2/rebased') {
    throw new Error(`expected branch tui2/rebased, got ${branchName}`);
  }
  if (pkg.version !== '0.38.0') {
    throw new Error(`expected @moonshot-ai/kimi-code version 0.38.0, got ${pkg.version}`);
  }
  return `branch=${branchName}, version=${pkg.version}`;
});

check('working tree clean', () => {
  const r = run('git', ['status', '--porcelain']);
  if (!r.ok) throw new Error(r.stderr || r.stdout);
  const dirty = r.stdout
    .split('\n')
    .map((line) => line)
    .filter((line) => line.trim().length > 0);
  if (dirty.length > 0) {
    throw new Error(`working tree dirty:\n${dirty.join('\n')}`);
  }
  return 'no staged/modified files';
});

check('typecheck:tui2', () => {
  const r = run(
    `${BUN} --bun ${join(REPO_ROOT, 'node_modules', '.bin', 'tsc')}`,
    ['-p', 'apps/kimi-code/tsconfig.tui2.json', '--noEmit'],
  );
  if (!r.ok) throw new Error(r.stderr || r.stdout);
  return 'clean';
});

check('vitest test/tui2', () => {
  const r = run(`${BUN} --bun ${VITEST_BIN}`, ['run', 'test/tui2/'], {
    cwd: join(REPO_ROOT, 'apps', 'kimi-code'),
  });
  if (!r.ok) throw new Error(r.stderr || r.stdout);
  const match = /Tests\s+(\d+)\s+passed\s+\((\d+)\)/.exec(r.stdout);
  if (!match) throw new Error(`could not parse vitest summary: ${r.stdout}`);
  const [, passed, total] = match;
  if (passed !== total) {
    throw new Error(`vitest reports ${passed}/${total} passed, not all-green`);
  }
  return `${passed}/${total} tests green`;
});

check('oxlint apps/kimi-code/src/tui2 (non-type-aware)', () => {
  const r = run(
    `${BUN} --bun ${join(REPO_ROOT, 'node_modules', '.bin', 'oxlint')}`,
    ['apps/kimi-code/src/tui2'],
  );
  if (!r.ok) {
    // oxlint exits 0 even on warnings; non-zero is a hard error.
    throw new Error(r.stderr || r.stdout);
  }
  const match = /Found\s+(\d+)\s+warnings?\s+and\s+(\d+)\s+errors?/.exec(r.stdout);
  const errors = match ? Number(match[2]) : null;
  if (errors !== null && errors > 0) {
    throw new Error(`oxlint reports ${errors} errors in apps/kimi-code/src/tui2`);
  }
  const warnings = match ? match[1] : '?';
  return `0 errors, ${warnings} warnings`;
});

check('sherif', () => {
  const r = run(
    `${BUN} --bun ${join(REPO_ROOT, 'node_modules', '.bin', 'sherif')}`,
    [],
  );
  // sherif exits non-zero on errors (not warnings). kimi-build is
  // intentionally excluded from workspace per AGENTS.md, so the lone
  // packages-without-package-json warning is expected.
  if (!r.ok) {
    throw new Error(r.stdout || r.stderr);
  }
  if (!/⨯\s*error/.test(r.stdout)) return '0 errors (kimi-build workspace warning is expected)';
  throw new Error(r.stdout);
});

check('check-locale-keys.mjs', () => {
  const r = run('node', ['scripts/check-locale-keys.mjs']);
  if (!r.ok) throw new Error(r.stdout || r.stderr);
  if (!/All locale keys are consistent/.test(r.stdout)) {
    throw new Error(`unexpected output: ${r.stdout}`);
  }
  return 'consistent';
});

check('check-locale-placeholders.cjs', () => {
  const r = run('node', ['scripts/check-locale-placeholders.cjs']);
  if (!r.ok) throw new Error(r.stdout || r.stderr);
  if (!/placeholders are well-formed and consistent/.test(r.stdout)) {
    throw new Error(`unexpected output: ${r.stdout}`);
  }
  return 'consistent';
});

check('trace AgentSwarmProgressView wiring', () => {
  const mainShell = readFileSync(
    join(REPO_ROOT, 'apps/kimi-code/src/tui2/components/main-shell.tsx'),
    'utf8',
  );
  const index = readFileSync(
    join(REPO_ROOT, 'apps/kimi-code/src/tui2/components/index.ts'),
    'utf8',
  );
  const view = readFileSync(
    join(
      REPO_ROOT,
      'apps/kimi-code/src/tui2/components/messages/agent-swarm-progress-view.tsx',
    ),
    'utf8',
  );
  const issues = [];
  if (!/import\s+\{\s*AgentSwarmProgressView\s*\}\s+from\s+'\.\/messages\/agent-swarm-progress-view'/.test(mainShell)) {
    issues.push('main-shell.tsx missing AgentSwarmProgressView import');
  }
  if (!/<AgentSwarmProgressView\s+/.test(mainShell)) {
    issues.push('main-shell.tsx does not render <AgentSwarmProgressView>');
  }
  if (!index.includes("./messages/agent-swarm-progress-view")) {
    issues.push('components/index.ts missing re-export of agent-swarm-progress-view');
  }
  if (!/^export function swarmStatusTone\b/m.test(view)) {
    issues.push('view missing export of swarmStatusTone');
  }
  if (!/^export function swarmStatusLabel\b/m.test(view)) {
    issues.push('view missing export of swarmStatusLabel');
  }
  if (!/tui\.messages\.agentSwarmProgress\.membersCount/.test(view)) {
    issues.push('view missing i18n key tui.messages.agentSwarmProgress.membersCount');
  }
  if (!/tui\.messages\.agentSwarmProgress\.failedCount/.test(view)) {
    issues.push('view missing i18n key tui.messages.agentSwarmProgress.failedCount');
  }
  if (issues.length > 0) {
    throw new Error(issues.join('\n'));
  }
  return 'import + render + export + i18n keys all present';
});

check('escape-case warnings', () => {
  const r = run(
    `${BUN} --bun ${join(REPO_ROOT, 'node_modules', '.bin', 'oxlint')}`,
    ['apps/kimi-code/src/tui2'],
  );
  const count = (r.stdout.match(/unicorn\(escape-case\)/g) ?? []).length;
  if (count > 0) {
    throw new Error(`unicorn(escape-case) reports ${count} warnings (run \`bun scripts/audit-tui2.mjs\` after \`bun scripts/escape-fix.mjs\` or the previous mechanical uppercase pass)`);
  }
  return '0 warnings';
});

check('consistent-type-imports warnings', () => {
  const r = run(
    `${BUN} --bun ${join(REPO_ROOT, 'node_modules', '.bin', 'oxlint')}`,
    ['apps/kimi-code/src/tui2'],
  );
  const count = (r.stdout.match(/consistent-type-imports/g) ?? []).length;
  if (count > 0) {
    throw new Error(`consistent-type-imports reports ${count} warnings; inline \`import()\` type annotations leaked back in`);
  }
  return '0 warnings';
});

check('prefer-string-slice warnings', () => {
  const r = run(
    `${BUN} --bun ${join(REPO_ROOT, 'node_modules', '.bin', 'oxlint')}`,
    ['apps/kimi-code/src/tui2'],
  );
  const count = (r.stdout.match(/unicorn\(prefer-string-slice\)/g) ?? []).length;
  if (count > 0) {
    throw new Error(`prefer-string-slice reports ${count} warnings — \`.substring(...)\` leaked back into tui2`);
  }
  return '0 warnings';
});

check('prefer-string-replace-all warnings', () => {
  const r = run(
    `${BUN} --bun ${join(REPO_ROOT, 'node_modules', '.bin', 'oxlint')}`,
    ['apps/kimi-code/src/tui2'],
  );
  const count = (r.stdout.match(/unicorn\(prefer-string-replace-all\)/g) ?? []).length;
  // The 2 currently-remaining cases are the prefer-literal-regex secondary
  // warnings (the linter thinks \\t and \\\\ are trivial enough to
  // inline as literal strings). Run-away guard: any increase past 2 is
  // suspicious; the audit will tell you about it.
  if (count > 2) {
    throw new Error(`prefer-string-replace-all reports ${count} warnings; expected ≤ 2 (the two known prefer-literal-regex tail warnings); investigate the regression`);
  }
  return count === 0 ? '0 warnings' : `${count} warnings (tail of prefer-literal-regex; flagged soft)`;
});

check('prefer-at warnings', () => {
  const r = run(
    `${BUN} --bun ${join(REPO_ROOT, 'node_modules', '.bin', 'oxlint')}`,
    ['apps/kimi-code/src/tui2'],
  );
  const count = (r.stdout.match(/unicorn\(prefer-at\)/g) ?? []).length;
  if (count > 0) {
    throw new Error(`prefer-at reports ${count} warnings — \`arr[arr.length - 1]\` leaked back in`);
  }
  return '0 warnings';
});

check('no-array-sort warnings', () => {
  const r = run(
    `${BUN} --bun ${join(REPO_ROOT, 'node_modules', '.bin', 'oxlint')}`,
    ['apps/kimi-code/src/tui2'],
  );
  const count = (r.stdout.match(/unicorn\(no-array-sort\)/g) ?? []).length;
  if (count > 0) {
    throw new Error(`no-array-sort reports ${count} warnings — use \`.toSorted()\` instead of \`.sort()\` for non-mutating order`);
  }
  return '0 warnings';
});

check('no-immediate-mutation warnings', () => {
  const r = run(
    `${BUN} --bun ${join(REPO_ROOT, 'node_modules', '.bin', 'oxlint')}`,
    ['apps/kimi-code/src/tui2'],
  );
  const count = (r.stdout.match(/unicorn\(no-immediate-mutation\)/g) ?? []).length;
  if (count > 0) {
    throw new Error(`no-immediate-mutation reports ${count} warnings — fold \`push()\` / \`Map.set()\` calls into the literal initializer or chain expression`);
  }
  return '0 warnings';
});

check('no-duplicates import warnings', () => {
  const r = run(
    `${BUN} --bun ${join(REPO_ROOT, 'node_modules', '.bin', 'oxlint')}`,
    ['apps/kimi-code/src/tui2'],
  );
  const count = (r.stdout.match(/import\(no-duplicates\)/g) ?? []).length;
  if (count > 0) {
    throw new Error(`import(no-duplicates) reports ${count} warnings — same module imported twice in one file (probably via a hoisted type-only import and a value import below it)`);
  }
  return '0 warnings';
});

check('always-return warnings', () => {
  const r = run(
    `${BUN} --bun ${join(REPO_ROOT, 'node_modules', '.bin', 'oxlint')}`,
    ['apps/kimi-code/src/tui2'],
  );
  const count = (r.stdout.match(/promise\(always-return\)/g) ?? []).length;
  if (count > 0) {
    throw new Error(`promise(always-return) reports ${count} warnings — every \`.then()\` callback must return explicitly (added \`return;\` to close out the body in 7 callbacks)`);
  }
  return '0 warnings';
});

check('orphan stash survey', () => {
  const r = run('git', ['stash', 'list']);
  if (!r.ok) throw new Error(r.stderr || r.stdout);
  const lines = r.stdout.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return 'no stashes';
  }
  // For each stash, compare ONLY its files against each ref. This avoids
  // the "4014 files changed" noise from a tree-vs-branch whole-repo diff
  // and tells us whether the stash content is reachable elsewhere.
  const refs = ['HEAD', 'main', 'origin/main', 'tui2/rebased', 'origin/tui2/rebased'];
  const anchoredRefs = refs.filter(
    (ref) => run('git', ['rev-parse', '--verify', '--quiet', ref], { shell: false }).ok,
  );
  const reports = [];
  for (let i = 0; i < lines.length; i += 1) {
    const idx = `stash@{${i}}`;
    const subject = (lines[i] ?? '').replace(/^stash@\{\d+\}: /, '');
    const fileList = run(
      'git',
      ['-c', 'diff.mnemonicPrefix=false', 'stash', 'show', '--name-only', idx],
      { shell: false },
    )
      .stdout.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const summaries = [];
    for (const ref of anchoredRefs) {
      let diffedAny = false;
      let filesUnchanged = 0;
      for (const file of fileList) {
        const r2 = run(
          'git',
          ['diff', '--quiet', `${idx}^{tree}`, ref, '--', file],
          { shell: false },
        );
        if (!r2.ok) {
          diffedAny = true;
          break;
        }
        filesUnchanged += 1;
      }
      if (!diffedAny) {
        summaries.push(`${ref}: identical (${filesUnchanged}/${fileList.length} files match)`);
      } else {
        summaries.push(`${ref}: unique content`);
      }
    }
    reports.push(
      `  ${idx}  ${subject}\n    files: ${fileList.length}\n    ${summaries.join('\n    ')}`,
    );
  }
  throw new Error(
    `${lines.length} stash(es) — review reachability before any drop:\n${reports.join('\n')}`,
  );
});

check('napi-rs retired tmp files', () => {
  const r = run(
    'bash',
    ['-lc', `ls -1 "${join(REPO_ROOT, 'packages', 'kimi-native-tools')}" 2>/dev/null | grep -cE '\\.retired\\.tmp\\.|\\.prepared\\.tmp\\.|\\.0\\.rollback\\.tmp\\.|\\.napi-rs-swp-bak-' || true`],
    { shell: false },
  );
  const count = Number((r.stdout || '0').trim()) || 0;
  // napi-rs tmp files are gitignored; warn on accumulation but don't fail
  // the build because they're harmless when the native pipeline isn't run.
  if (count > 20) {
    return `${count} tmp file(s) (consider \`rm\` of retired ones)`;
  }
  return `${count} tmp file(s)`;
});

const WIDTH = Math.max(...checks.map((c) => c.name.length));

let failures = 0;
for (const c of checks) {
  const padded = c.name.padEnd(WIDTH);
  try {
    const detail = c.fn();
    process.stdout.write(`${GREEN}✓${RESET} ${padded}  ${detail}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`${RED}✗${RESET} ${padded}\n`);
    process.stdout.write(`${YELLOW}  ${String(error.message ?? error).split('\n').join(`\n  `)}${RESET}\n`);
  }
}

process.stdout.write('\n');
if (failures === 0) {
  process.stdout.write(`${GREEN}${checks.length}/${checks.length} checks passed${RESET}\n`);
  process.exit(0);
} else {
  process.stdout.write(
    `${RED}${failures}/${checks.length} checks FAILED${RESET}\n`,
  );
  process.exit(1);
}
