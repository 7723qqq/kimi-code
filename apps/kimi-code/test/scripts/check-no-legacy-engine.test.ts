import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/check-no-legacy-engine.mjs');

// Probes live inside a scanned, non-skipped directory so the gate really reads
// them; `afterEach` removes them so the committed tree's verdict is untouched.
const SCRATCH_DIR = join(REPO_ROOT, 'packages/protocol');
const PROBE_TS = join(SCRATCH_DIR, 'zz-legacy-probe.ts');
const PROBE_MD = join(SCRATCH_DIR, 'zz-legacy-probe.md');
const PROBE_PKG_DIR = join(SCRATCH_DIR, 'zz-legacy-probe-pkg');

// The gate scans this very file, so a retired specifier cannot be written as a
// literal here without flagging the test suite itself. Build the probe strings
// from fragments instead; the assembled value is what lands in the probe file.
const SCOPE = '@moonshot-ai/';
const V2 = ['agent', 'core', 'v2'].join('-');
const KLIENT = ['kli', 'ent'].join('');
const acpSpecifier = (): string => `import x from '${SCOPE}acp-server';\n`;

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
  rmSync(PROBE_TS, { force: true });
  rmSync(PROBE_MD, { force: true });
  rmSync(PROBE_PKG_DIR, { recursive: true, force: true });
});

// The repository is clean, so a suite that only asserted the happy path would
// stay green even if the gate stopped scanning entirely. These pin the reject
// side — and the markdown exemption, which is a deliberate hole.
describe('check-no-legacy-engine gate', () => {
  it('passes on the committed tree', () => {
    const { code, output } = runGate();
    expect(output).toContain('no retired-engine references');
    expect(code).toBe(0);
  });

  it('fails on a retired-package import specifier', () => {
    writeFileSync(PROBE_TS, `import x from '${SCOPE}${V2}';\n`, 'utf8');

    const { code, output } = runGate();
    expect(code).not.toBe(0);
    expect(output).toContain('retired package specifier in code');
    // The report must name the offending file, or the fix is a guessing game.
    expect(output).toContain('zz-legacy-probe.ts');
  });

  it('fails on a retired-package dependency entry', () => {
    mkdirSync(PROBE_PKG_DIR, { recursive: true });
    writeFileSync(
      join(PROBE_PKG_DIR, 'package.json'),
      JSON.stringify({ name: 'probe', dependencies: { [`${SCOPE}${KLIENT}`]: 'workspace:*' } }),
      'utf8',
    );

    const { code, output } = runGate();
    expect(code).not.toBe(0);
    expect(output).toContain('dependency entry on a retired package');
  });

  it('ignores prose mentions in markdown', () => {
    // Deliberate hole: ROADMAP.md and the changelogs name these packages.
    writeFileSync(PROBE_MD, `See \`${SCOPE}${V2}\` for the retired package.\n`, 'utf8');
    expect(runGate().code).toBe(0);
  });

  it('recovers once the probe is removed', () => {
    writeFileSync(PROBE_TS, acpSpecifier(), 'utf8');
    expect(runGate().code).not.toBe(0);

    rmSync(PROBE_TS, { force: true });
    expect(runGate().code).toBe(0);
  });
});
