import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const FLAKE = join(REPO_ROOT, 'flake.nix');
const SCRIPT = join(REPO_ROOT, 'scripts/check-nix-workspace.mjs');

const original = readFileSync(FLAKE, 'utf8');

/** Run the gate and return its exit code plus combined output. */
function runGate(): { code: number; output: string } {
  try {
    const stdout = execFileSync('bun', [SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output: stdout };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

afterEach(() => {
  writeFileSync(FLAKE, original, 'utf8');
});

// A gate that cannot fail is not a gate. The repository currently passes, so a
// suite that only asserted the happy path would stay green even if the script
// stopped detecting drift entirely — these pin the *reject* side.
describe('check-nix-workspace gate', () => {
  it('passes on the committed flake.nix', () => {
    const { code, output } = runGate();
    expect(output).toContain('present in flake.nix');
    expect(code).toBe(0);
  });

  it('fails when a workspace dependency is dropped from flake.nix', () => {
    writeFileSync(FLAKE, original.replace('./packages/kaos\n', ''), 'utf8');

    const { code, output } = runGate();
    expect(code).not.toBe(0);
    expect(output).toContain('./packages/kaos');
    // The report must name the package, not only the path, so the fix is obvious.
    expect(output).toContain('@moonshot-ai/kaos');
  });

  it('fails when the start package itself is missing', () => {
    writeFileSync(FLAKE, original.replace('./apps/kimi-code\n', ''), 'utf8');

    const { code, output } = runGate();
    expect(code).not.toBe(0);
    expect(output).toContain('@moonshot-ai/kimi-code');
  });

  it('fails when every path is removed', () => {
    writeFileSync(
      FLAKE,
      original.replace(/workspacePaths = \[[\s\S]*?\]/, 'workspacePaths = []'),
      'utf8',
    );
    expect(runGate().code).not.toBe(0);
  });

  it('recovers once the path is restored', () => {
    writeFileSync(FLAKE, original.replace('./packages/kaos\n', ''), 'utf8');
    expect(runGate().code).not.toBe(0);

    writeFileSync(FLAKE, original, 'utf8');
    expect(runGate().code).toBe(0);
  });
});
