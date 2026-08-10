/**
 * Outcome-based progress tracking tests (ported from Reasonix's
 * `internal/evidence/outcome_test.go`).
 */

import { describe, expect, it } from 'vitest';

import { isVerificationCommand, ProgressTracker, type ToolReceipt } from '#/agent/progressTrack/progressTracker';

function write(path: string, toolName = 'Write'): ToolReceipt {
  return { toolName, success: true, paths: { read: [], write: [path] } };
}

function read(path: string, toolName = 'Read'): ToolReceipt {
  return { toolName, success: true, paths: { read: [path], write: [] } };
}

function command(cmd: string, success = true, toolName = 'Bash'): ToolReceipt {
  return { toolName, command: cmd, success };
}

describe('isVerificationCommand', () => {
  it('recognizes test runners', () => {
    expect(isVerificationCommand('npm test')).toBe(true);
    expect(isVerificationCommand('pnpm test')).toBe(true);
    expect(isVerificationCommand('go test ./...')).toBe(true);
    expect(isVerificationCommand('cargo test')).toBe(true);
    expect(isVerificationCommand('pytest tests/')).toBe(true);
    expect(isVerificationCommand('make test')).toBe(true);
    expect(isVerificationCommand('vitest run')).toBe(true);
    expect(isVerificationCommand('python -m pytest')).toBe(true);
  });

  it('recognizes check/verify keywords', () => {
    expect(isVerificationCommand('node --check src/main.ts')).toBe(true);
    expect(isVerificationCommand('tsc --noEmit')).toBe(true);
  });

  it('does not classify build/run commands as verification', () => {
    expect(isVerificationCommand('npm run build')).toBe(false);
    expect(isVerificationCommand('pnpm install')).toBe(false);
    expect(isVerificationCommand('git status')).toBe(false);
    expect(isVerificationCommand('ls')).toBe(false);
  });
});

describe('ProgressTracker', () => {
  it('counts exploration for first-time reads and new commands', () => {
    const t = new ProgressTracker();
    const s1 = t.scoreRound([read('/a.txt')]);
    expect(s1.exploration).toBe(1);
    // Same path again: no new exploration.
    const s2 = t.scoreRound([read('/a.txt')]);
    expect(s2.exploration).toBe(0);
    const s3 = t.scoreRound([command('ls')]);
    expect(s3.exploration).toBe(1);
  });

  it('tracks churn for writes and opens verification debt', () => {
    const t = new ProgressTracker();
    const s1 = t.scoreRound([write('/src/a.ts')]);
    expect(s1.churn).toBe(1);
    expect(s1.blindMutations).toBe(1);
    expect(s1.debtAge).toBe(1);
    const s2 = t.scoreRound([write('/src/b.ts')]);
    expect(s2.blindMutations).toBe(2);
    expect(s2.debtAge).toBe(2);
  });

  it('clears debt and blind mutations on a verification run', () => {
    const t = new ProgressTracker();
    t.scoreRound([write('/src/a.ts')]);
    t.scoreRound([write('/src/b.ts')]);
    const s = t.scoreRound([command('npm test')]);
    expect(s.verification).toBe(1);
    expect(s.discriminating).toBe(1);
    expect(s.blindMutations).toBe(0);
    expect(s.debtAge).toBe(0);
    const next = t.scoreRound([write('/src/c.ts')]);
    expect(next.blindMutations).toBe(1);
  });

  it('counts objective (fail->pass) and regression (pass->fail) transitions', () => {
    const t = new ProgressTracker();
    t.scoreRound([command('npm test', false)]);
    const pass = t.scoreRound([command('npm test', true)]);
    expect(pass.objective).toBe(1);
    expect(pass.verification).toBe(1);
    const fail = t.scoreRound([command('npm test', false)]);
    expect(fail.regression).toBe(1);
  });

  it('counts a command exercising a mutated file as discriminating', () => {
    const t = new ProgressTracker();
    t.scoreRound([write('/src/app.py')]);
    // Running the mutated file's module exercises it -> discriminating.
    const s = t.scoreRound([command('python src/app.py')]);
    expect(s.discriminating).toBe(1);
    expect(s.blindMutations).toBe(0);
  });

  it('counts repeated failures as one exploration unit', () => {
    const t = new ProgressTracker();
    t.scoreRound([command('npm test', false)]);
    const again = t.scoreRound([command('npm test', false)]);
    expect(again.exploration).toBe(0);
  });
});
