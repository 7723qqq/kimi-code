import { findUpwardRoot } from '#/_base/utils/paths';

export const TEST_SCOPE_GUARD_ENV = 'KIMI_CODE_TEST_SCOPE_GUARD';

export const TEST_SCOPE_REMINDER_VARIANT = 'test-scope-guard';

export const TEST_SCOPE_NARROWING_HINT =
  'cd packages/<package> && bun test --isolate <test-file…>';

const WHOLE_SUITE_COMMANDS: readonly RegExp[] = [
  /^bun\s+test(?=\s|$)/,
  /^bun\s+(?:--bun\s+)?run\s+(?:test|test:heavy|verify)(?=\s|$)/,
  /^bun\s+(?:\.\/)?scripts\/verify-packages\.mjs(?=\s|$)/,
  /^(?:npm|pnpm|yarn)\s+(?:run\s+)?test(?=\s|$)/,
  /^bun\s+vitest\s+(?:run|watch)(?=\s|$)/,
  /^(?:bunx\s+)?vitest\s+(?:run|watch)(?=\s|$)/,
];

const NARROWING_FLAGS = /(?:^|\s)(?:--project|--test-name-pattern|--filter|--shard|--dir)(?=[\s=]|$)/;

const COMMAND_SEPARATOR = /\s*(?:&&|\|\||[;&|\n])\s*/;

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/;

const LEADING_CD = /^\s*cd\s+([^\s;&|]+)\s*(?:&&|;)/;

const PATH_SEPARATOR = /[\\/]/;

const TEST_FILE_PATH = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

export interface TestScopeInput {
  readonly command: string;
  readonly cwd: string;
  readonly workspaceRoot: string;
}

export interface RepositoryRootInput {
  readonly workDir: string;
  readonly exists: (path: string) => Promise<boolean>;
}

export function normalizeDirectory(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
}

export function repositoryRootOf(input: RepositoryRootInput): Promise<string> {
  return findUpwardRoot(input.workDir, '.git', input.exists);
}

export function runsFromWorkspaceRoot(input: TestScopeInput): boolean {
  const base = normalizeDirectory(input.cwd);
  const cd = LEADING_CD.exec(stripEnvAssignments(input.command));
  if (cd === null) return base === normalizeDirectory(input.workspaceRoot);
  const target = (cd[1] ?? '').trim();
  if (target === '' || target === '.' || target === './') {
    return base === normalizeDirectory(input.workspaceRoot);
  }
  if (/^[a-zA-Z]:/.test(target) || target.startsWith('/')) {
    return normalizeDirectory(target) === normalizeDirectory(input.workspaceRoot);
  }
  return false;
}

export function wholeSuiteRunWarning(input: TestScopeInput): string | undefined {
  if (!runsFromWorkspaceRoot(input)) return undefined;
  for (const part of input.command.split(COMMAND_SEPARATOR)) {
    const segment = stripEnvAssignments(part);
    const matched = wholeSuiteMatchLength(segment);
    if (matched === undefined) continue;
    if (NARROWING_FLAGS.test(segment)) continue;
    const firstToken = segment.slice(matched).trim().split(/\s+/)[0] ?? '';
    if (firstToken.length === 0 || firstToken.startsWith('-')) return renderReminder(input.command);
    if (PATH_SEPARATOR.test(firstToken) || TEST_FILE_PATH.test(firstToken)) continue;
    return renderReminder(input.command);
  }
  return undefined;
}

function wholeSuiteMatchLength(segment: string): number | undefined {
  for (const pattern of WHOLE_SUITE_COMMANDS) {
    const match = pattern.exec(segment);
    if (match !== null) return match[0].length;
  }
  return undefined;
}

function stripEnvAssignments(segment: string): string {
  let rest = segment.trim();
  while (true) {
    const match = ENV_ASSIGNMENT.exec(rest);
    if (match === null) return rest;
    rest = rest.slice(match[0].length);
  }
}

export function renderReminder(command: string): string {
  return [
    `\`${command.trim()}\` ran the workspace's test suites from the repository root.`,
    'All-suites is the CI bar, not the default scope for a change: it costs minutes and tells you',
    'little that the affected tests do not. Start from the tests that cover what you touched, then',
    `the owning package's suite (\`${TEST_SCOPE_NARROWING_HINT}\`), and widen only when the change`,
    'crosses packages, alters a shared contract, or the user asks for the full run. This note does',
    'not change the completion bar — whatever you scoped to must still run and pass.',
  ].join(' ');
}
