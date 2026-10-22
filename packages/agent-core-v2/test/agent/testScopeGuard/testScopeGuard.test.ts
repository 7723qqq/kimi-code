import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, describe, expect, it } from 'bun:test';

import {
  normalizeDirectory,
  renderReminder,
  repositoryRootOf,
  runsFromWorkspaceRoot,
  wholeSuiteRunWarning,
} from '#/agent/testScopeGuard/testScopeGuard';
import { HostFileSystem } from '#/os/backends/host/hostFsService';

const ROOT = 'C:\\work\\repo';

function warn(command: string, cwd: string = ROOT): string | undefined {
  return wholeSuiteRunWarning({ command, cwd, workspaceRoot: ROOT });
}

describe('runsFromWorkspaceRoot', () => {
  it('treats a bare command at the workspace root as a root run', () => {
    expect(runsFromWorkspaceRoot({ command: 'bun test', cwd: ROOT, workspaceRoot: ROOT })).toBe(
      true,
    );
  });

  it('treats a leading cd into a subdirectory as narrowed', () => {
    expect(
      runsFromWorkspaceRoot({ command: 'cd pkg-a && bun test', cwd: ROOT, workspaceRoot: ROOT }),
    ).toBe(false);
  });

  it('treats a cd to the root itself as a root run', () => {
    expect(
      runsFromWorkspaceRoot({ command: 'cd . && bun test', cwd: ROOT, workspaceRoot: ROOT }),
    ).toBe(true);
  });

  it('treats a session already inside a package as narrowed', () => {
    expect(
      runsFromWorkspaceRoot({
        command: 'bun test',
        cwd: 'C:\\work\\repo\\packages\\agent-core-v2',
        workspaceRoot: ROOT,
      }),
    ).toBe(false);
  });
});

describe('wholeSuiteRunWarning', () => {
  it('warns for a bare bun test at the root', () => {
    expect(warn('bun test')).toContain('All-suites is the CI bar');
  });

  it('warns for the root test script', () => {
    expect(warn('bun run test')).toBeDefined();
  });

  it('warns for the bun-runtime variant of the root script', () => {
    expect(warn('bun --bun run test')).toBeDefined();
  });

  it('warns for vitest run without a path', () => {
    expect(warn('vitest run')).toBeDefined();
    expect(warn('bunx vitest run')).toBeDefined();
  });

  it('warns for npm and yarn test', () => {
    expect(warn('npm test')).toBeDefined();
    expect(warn('yarn run test')).toBeDefined();
  });

  it('stays quiet when the package is named first', () => {
    expect(warn('cd pkg-a && bun test')).toBeUndefined();
    expect(warn('cd packages/agent-core-v2 && bun run test')).toBeUndefined();
  });

  it('stays quiet when a test path is named', () => {
    expect(warn('bun test test/agent/usage/usageEvents.test.ts')).toBeUndefined();
    expect(warn('bun test src/agent/usage')).toBeUndefined();
  });

  it('stays quiet when a project or name filter narrows the run', () => {
    expect(warn('bun test --project cli')).toBeUndefined();
    expect(warn('vitest run --project agent-core-v2')).toBeUndefined();
    expect(warn('bun test --test-name-pattern usage')).toBeUndefined();
  });

  it('warns for the repository-wide verify scripts', () => {
    expect(warn('bun run verify')).toContain('All-suites is the CI bar');
    expect(warn('bun run test:heavy')).toContain('All-suites is the CI bar');
    expect(warn('bun scripts/verify-packages.mjs')).toContain('All-suites is the CI bar');
  });

  it('warns when the run carries leading environment assignments', () => {
    expect(warn('CI=1 bun test')).toContain('All-suites is the CI bar');
    expect(warn('CI=1 NODE_OPTIONS=--max-old-space-size=4096 bun run test')).toContain(
      'All-suites is the CI bar',
    );
  });

  it('applies narrowing flags only to the segment that carries them', () => {
    expect(warn('bun run test && bun test --filter usage')).toContain('All-suites is the CI bar');
    expect(warn('bun test --filter usage && bun run verify')).toContain(
      'All-suites is the CI bar',
    );
  });

  it('stays quiet when an env-prefixed command cds into a package', () => {
    expect(warn('CI=1 cd pkg-a && bun test')).toBeUndefined();
  });

  it('stays quiet for unrelated commands', () => {
    expect(warn('bun run build')).toBeUndefined();
    expect(warn('git status')).toBeUndefined();
  });

  it('renders the narrowing hint and keeps the completion bar', () => {
    const text = renderReminder('bun run test');
    expect(text).toContain('cd packages/<package> && bun test --isolate <test-file…>');
    expect(text).toContain('does not change the completion bar');
  });
});

describe('repositoryRootOf', () => {
  const fs = new HostFileSystem();
  const checkouts: string[] = [];

  afterEach(async () => {
    for (const checkout of checkouts.splice(0)) {
      await rm(checkout, { recursive: true, force: true });
    }
  });

  async function markerExists(marker: string): Promise<boolean> {
    try {
      await fs.stat(marker);
      return true;
    } catch {
      return false;
    }
  }

  async function makeCheckout(): Promise<{ root: string; pkg: string }> {
    const root = await mkdtemp(join(tmpdir(), 'kimi-test-scope-'));
    checkouts.push(root);
    await mkdir(join(root, '.git'), { recursive: true });
    const pkg = join(root, 'packages', 'agent-core-v2');
    await mkdir(pkg, { recursive: true });
    return { root, pkg };
  }

  it('resolves the checkout root so a session inside a package counts as narrowed', async () => {
    const { root, pkg } = await makeCheckout();
    const workspaceRoot = await repositoryRootOf({ workDir: pkg, exists: markerExists });
    expect(normalizeDirectory(workspaceRoot)).toBe(normalizeDirectory(root));
    expect(runsFromWorkspaceRoot({ command: 'bun test', cwd: pkg, workspaceRoot })).toBe(false);
    expect(wholeSuiteRunWarning({ command: 'bun test', cwd: pkg, workspaceRoot })).toBeUndefined();
  });

  it('resolves the checkout root itself when the session runs there', async () => {
    const { root } = await makeCheckout();
    const workspaceRoot = await repositoryRootOf({ workDir: root, exists: markerExists });
    expect(
      wholeSuiteRunWarning({ command: 'bun test', cwd: root, workspaceRoot }),
    ).toContain('All-suites is the CI bar');
  });
});
